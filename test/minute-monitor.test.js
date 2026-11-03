import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMonitor, monitorSession, positionIdentity } from '../api/_minute-monitor.js';
import { createMonitorHandler } from '../api/minute-monitor.js';
import { priceRiskGate, rulesGate } from '../api/_sell-engine.js';

const now = new Date('2026-11-03T05:30:00Z'), key = 'NSE_EQ|INE745G01043';
const p = { ticker: 'MCX', date: '2026-11-02', addedAt: '2026-11-02T05:30:00Z', entryPrice: 100,
  currentPrice: 100, peakPrice: 100, initialStopPrice: 95, initialStopPct: 5, initialTrailPct: 4, entryLane: 'momentum' };
const q = (price, ms = now.getTime() - 1000) => ({ [key]: { instrumentKey: key, symbol: 'MCX', price,
  lastTradeAt: new Date(ms).toISOString(), responseAt: now.toISOString() } });

test('monitor observes a separate peak without mutating the live holding', () => {
  const original = structuredClone(p), result = evaluateMonitor([p], q(110), { MCX: key }, {}, { now });
  assert.deepEqual(p, original); assert.equal(result.positions[0].status, 'hold');
  assert.equal(result.nextState.positions[positionIdentity(p)].peakPrice, 110);
});

test('stale and future quotes cannot change peaks or trigger a sell', () => {
  for (const time of [now.getTime() - 180000, now.getTime() + 180000]) {
    const r = evaluateMonitor([p], q(80, time), { MCX: key }, {}, { now });
    assert.equal(r.positions[0].status, 'unusable_price'); assert.equal(r.signals.length, 0);
    assert.deepEqual(r.nextState.positions, {});
  }
});

test('duplicate/out-of-order quote and repeated stop signals are idempotent', () => {
  const first = evaluateMonitor([p], q(94), { MCX: key }, {}, { now });
  assert.equal(first.signals.length, 1);
  const dup = evaluateMonitor([p], q(94), { MCX: key }, first.nextState, { now });
  assert.equal(dup.positions[0].status, 'duplicate_quote'); assert.equal(dup.signals.length, 0);
  const newer = evaluateMonitor([p], q(93, now.getTime()), { MCX: key }, first.nextState, { now });
  assert.equal(newer.positions[0].status, 'signal_latched'); assert.equal(newer.signals.length, 0);
});

test('mapping outages preserve state and closed positions are pruned', () => {
  const first = evaluateMonitor([p], q(94), { MCX: key }, {}, { now });
  const missing = evaluateMonitor([p], {}, {}, first.nextState, { now });
  assert.deepEqual(missing.nextState.positions, first.nextState.positions);
  assert.deepEqual(evaluateMonitor([], {}, {}, first.nextState, { now }).nextState.positions, {});
});

test('missing entry risk and instrument identity mismatches fail closed', () => {
  assert.equal(evaluateMonitor([{ ...p, initialStopPrice: null }], q(94), { MCX: key }, {}, { now }).positions[0].status, 'missing_frozen_risk');
  const quotes = q(94); quotes[key].symbol = 'OTHER';
  assert.equal(evaluateMonitor([p], quotes, { MCX: key }, {}, { now }).positions[0].status, 'identity_mismatch');
});

test('monitor session excludes holidays, weekends, pre-open and close', () => {
  for (const at of ['2026-11-03T03:44:00Z', '2026-11-03T10:00:00Z', '2026-11-07T05:30:00Z', '2026-11-10T05:30:00Z']) assert.equal(monitorSession(new Date(at)).open, false);
  assert.equal(monitorSession(now).open, true);
});

test('factored price gate preserves existing stop/trail decisions and excludes overdue review exits', () => {
  for (const price of [94, 100, 105, 110]) {
    const a = { ...p, currentPrice: price, peakPrice: 110 }, b = structuredClone(a);
    assert.deepEqual(priceRiskGate(a, null, { heldSessions: 1 }), rulesGate(b, null, { heldSessions: 1 }));
  }
  assert.equal(priceRiskGate({ ...p }, null, { heldSessions: 99 }), null);
  assert.match(rulesGate({ ...p }, null, { heldSessions: 99 }).reason, /review overdue/);
});

test('HTTP monitor is disabled by default and enabled evaluation makes only injected read calls', async () => {
  const saved = process.env.CRON_SECRET; process.env.CRON_SECRET = 'test-only';
  const res = () => ({ code: 0, body: null, setHeader() {}, status(n) { this.code = n; return this; }, json(x) { this.body = x; return this; } });
  try {
    const req = { method: 'POST', headers: { authorization: 'Bearer test-only' }, body: {} };
    const off = res(); await createMonitorHandler({ env: {}, read: async () => { throw new Error('must not read'); } })(req, off);
    assert.equal(off.body.status, 'disabled');
    let reads = 0;
    const on = res(); await createMonitorHandler({ env: { UPSTOX_MONITOR_ENABLED: 'true', UPSTOX_ACCESS_TOKEN: 'test' }, now: () => now,
      read: async () => { reads++; return [p]; }, map: async () => ({ mapped: { MCX: key }, unresolved: [], ambiguous: [] }), quotes: async () => q(94) })(req, on);
    assert.equal(reads, 1); assert.equal(on.code, 200); assert.equal(on.body.positions[0].status, 'would_sell');
    assert.equal(on.body.mode, 'read-only-shadow');
  } finally { if (saved == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
});
