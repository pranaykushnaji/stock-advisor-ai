import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityMomentumChecks } from '../api/_scoring.js';
import { entryLaneDiagnostics } from '../api/_entry-lanes.js';
import { findResearchEntry, replayResearchExit, completedFiveMinuteBars, liveResearchEntry } from '../api/_entry-research.js';
import { createEntryResearchHandler } from '../api/_entry-research-handler.js';

test('official circuit policy distinguishes a daily high from an actual exchange band', () => {
  const closes = Array(252).fill(100), volumes = Array(252).fill(1000000);
  const ctx = { dayHigh: 100, dayLow: 95, pChange: 7, tradedValueCr: 100 };
  assert.ok(qualityMomentumChecks(closes, volumes, ctx).rejects.includes('near upper circuit'));
  assert.equal(qualityMomentumChecks(closes, volumes, { ...ctx, circuitPolicy: 'official' }).rejects.length, 0);
  assert.ok(qualityMomentumChecks(closes, volumes, { ...ctx, circuitPolicy: 'official', upperCircuit: 100 }).rejects.includes('near official upper circuit'));
});

test('lane diagnostics name the actual momentum blockers independently of absent news', () => {
  const d = entryLaneDiagnostics({ _qm: { relVol: 3.01 }, _catalyst: { hasCatalyst: false, verification: 'UNVERIFIED' }, _effConfMom: 67, _inst: { score: 56.9 } },
    { regime: { regime: 'bullish' }, gates: { minConfidence: 55 }, momLaneOpen: true,
      momentum: { REGIMES: ['bullish', 'neutral'], MIN_RELVOL: 2.5, CONF_EXTRA: 6, MIN_INSTITUTIONAL: 65 } });
  assert.deepEqual(d.momentum.reasons, ['accumulation proxy 56.9<65']);
  assert.match(d.catalyst.reasons[0], /UNVERIFIED/);
});

const start = Date.parse('2026-11-03T04:00:00Z');
function bars() {
  return Array.from({ length: 9 }, (_, i) => ({ ms: start + i * 300000, open: i < 7 ? 100 : 101,
    high: i < 6 ? 100.2 : 101.5, low: i < 6 ? 99.8 : 100.3, close: i < 6 ? 100 : 101,
    volume: i < 6 ? 100 : 300 }));
}

test('research enters only after a completed confirming candle at the next open', () => {
  const rows = bars(), e = findResearchEntry(rows, { notBefore: new Date(start).toISOString(), regime: 'bullish' });
  assert.equal(e.status, 'setup'); assert.equal(e.entryPrice, rows[7].open);
  assert.equal(Date.parse(e.signalAt), rows[6].ms + 300000);
  assert.equal(findResearchEntry(rows, { notBefore: new Date(start).toISOString(), regime: 'weak' }).status, 'blocked');
});

test('research gap losses use worse opening price and apply explicit friction', () => {
  const rows = bars(); rows[8] = { ...rows[8], open: 90, high: 91, low: 89, close: 90 };
  const e = findResearchEntry(rows, { notBefore: new Date(start).toISOString(), regime: 'bullish' });
  const exit = replayResearchExit(rows, e, { stopPct: 4, trailPct: 4 });
  assert.equal(exit.fillPrice, 90); assert.equal(exit.reason, 'gap through stop');
  assert.ok(Math.abs(exit.grossReturnPct - exit.netReturnPct - 0.3) < 0.000001);
});

function minuteCandles() {
  return bars().slice(0, 7).flatMap(b => Array.from({ length: 5 }, (_, j) => [new Date(b.ms + j * 60000).toISOString(), b.open, b.high, b.low, b.close, b.volume / 5]));
}

test('completed-bar aggregation rejects partial and missing minutes and does not invent candle order', () => {
  const one = minuteCandles(), now = new Date(start + 7 * 300000);
  assert.equal(completedFiveMinuteBars([...one].reverse(), now).length, 7);
  assert.equal(completedFiveMinuteBars(one.slice(1), now).length, 6);
  assert.equal(completedFiveMinuteBars(one, new Date(start + 7 * 300000 - 1000)).length, 6);
});

test('live research checks only the latest completed signal and uses current quote, never hindsight entry', () => {
  const now = new Date(start + 7 * 300000 + 5000);
  const q = { price: 101, lastTradeAt: now.toISOString() };
  const r = liveResearchEntry(minuteCandles(), q, { now, regime: 'bullish', firstSeenAt: new Date(start).toISOString() });
  assert.equal(r.status, 'setup'); assert.equal(r.entryAt, q.lastTradeAt);
  assert.equal(r.execution, 'shadow-quote-only');
  assert.equal(liveResearchEntry(minuteCandles(), q, { now: new Date(now.getTime() + 120000), regime: 'bullish' }).status, 'unavailable');
});

test('entry research observes proposed setups, latches them and skips held positions', async () => {
  const old = process.env.CRON_SECRET; process.env.CRON_SECRET = 'test';
  const now = new Date(start + 7 * 300000 + 5000), date = '2026-11-03', key = 'NSE_EQ|INE745G01043';
  const read = async () => ({ store: { date, candidates: {
    MCX: { ticker: 'MCX', scans: [{ ts: new Date(start).toISOString(), discoveryScore: 80 }] },
    HELD: { ticker: 'HELD', scans: [{ ts: new Date(start).toISOString(), discoveryScore: 99 }] },
  } }, pick: { date, regime: 'bullish' }, held: [{ ticker: 'HELD' }] });
  let candleCalls = 0;
  const handler = createEntryResearchHandler({ now: () => now, read,
    env: { ENTRY_SETUP_RESEARCH_ENABLED: 'true', UPSTOX_ACCESS_TOKEN: 'test' },
    map: async symbols => { assert.deepEqual(symbols, ['MCX']); return { mapped: { MCX: key }, unresolved: [], ambiguous: [] }; },
    quotes: async () => ({ [key]: { symbol: 'MCX', price: 101, lastTradeAt: now.toISOString(), responseAt: now.toISOString() } }),
    candles: async () => { candleCalls++; return minuteCandles(); } });
  const response = () => ({ body: null, setHeader() {}, status() { return this; }, json(d) { this.body = d; return this; } });
  try {
    const req = { method: 'POST', headers: { authorization: 'Bearer test' }, body: {} }, r = response();
    await handler(req, r); assert.equal(r.body.signals.length, 1);
    assert.equal(r.body.signals[0].productionGatesPassed, false);
    const again = response(); await handler({ ...req, body: { previousState: r.body.nextState } }, again);
    assert.equal(again.body.signals.length, 0); assert.equal(candleCalls, 1);
  } finally { if (old == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old; }
});
