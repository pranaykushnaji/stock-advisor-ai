import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cron-worker/worker.js';
import { UpstoxMonitor, isMonitorMinute, dispatchMonitor } from '../cron-worker/upstox-monitor.js';

class Storage {
  constructor() { this.values = new Map(); }
  async get(key) { return Array.isArray(key) ? new Map(key.filter(k => this.values.has(k)).map(k => [k, structuredClone(this.values.get(k))])) : structuredClone(this.values.get(key)); }
  async put(key, value) { if (typeof key === 'object') for (const [k, v] of Object.entries(key)) this.values.set(k, structuredClone(v)); else this.values.set(key, structuredClone(value)); }
  async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) this.values.delete(k); }
  async transaction(fn) { return fn(this); }
}

const ms = Date.parse('2026-11-03T05:30:00Z');
const env = { UPSTOX_MONITOR_ENABLED: 'true', UPSTOX_MONITOR_BASE: 'https://feature-preview.vercel.app', CRON_SECRET: 'test-only' };
const request = () => new Request('https://monitor.internal/tick', { method: 'POST', body: JSON.stringify({ scheduledTime: ms }) });

test('one-minute window matches regular NSE session and excludes weekends', () => {
  assert.equal(isMonitorMinute(new Date('2026-11-03T03:45:00Z')), true);
  assert.equal(isMonitorMinute(new Date('2026-11-03T09:59:00Z')), true);
  assert.equal(isMonitorMinute(new Date('2026-11-03T10:00:00Z')), false);
  assert.equal(isMonitorMinute(new Date('2026-11-07T05:30:00Z')), false);
});

test('monitor requires opt-in and rejects production origin before any dispatch', async () => {
  assert.equal((await dispatchMonitor({}, ms)).status, 'disabled');
  await assert.rejects(dispatchMonitor({ ...env, UPSTOX_MONITOR: {}, UPSTOX_MONITOR_BASE: 'https://stock-advisor-ai-omega.vercel.app' }, ms), /separate HTTPS preview/);
});

test('Durable Object serializes simultaneous ticks and suppresses duplicate minute work across restart', async t => {
  t.mock.method(Date, 'now', () => ms + 5000);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++; assert.equal(url, 'https://feature-preview.vercel.app/api/minute-monitor');
    assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, 'Bearer test-only');
    await Promise.resolve();
    return Response.json({ status: 'monitored', mode: 'read-only-shadow', nextState: { version: 1, positions: {} }, signals: [], positions: [] });
  });
  const storage = new Storage(), actor = new UpstoxMonitor({ storage }, env);
  const results = await Promise.all([actor.fetch(request()), actor.fetch(request())]);
  assert.equal(calls, 1); assert.equal((await results[1].json()).status, 'duplicate_or_old_slot');
  const restarted = new UpstoxMonitor({ storage }, env);
  assert.equal((await (await restarted.fetch(request())).json()).status, 'duplicate_or_old_slot');
  assert.equal(calls, 1); assert.equal((await storage.get('historyKeys')).length, 1);
});

test('provider failure leaves slot retryable; partial results preserve fresh state exactly once', async t => {
  t.mock.method(Date, 'now', () => ms + 5000);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return Response.json({ status: 'market_data_unavailable' }, { status: 502 });
    return Response.json({ status: 'monitor_incomplete', mode: 'read-only-shadow', nextState: { version: 1, positions: { A: { peakPrice: 100 } } }, positions: [], signals: [] }, { status: 502 });
  });
  const storage = new Storage(), actor = new UpstoxMonitor({ storage }, env);
  assert.equal((await actor.fetch(request())).status, 502);
  assert.equal(await storage.get('lastSlot'), undefined);
  assert.equal((await actor.fetch(request())).status, 200);
  assert.equal((await storage.get('shadowState')).positions.A.peakPrice, 100);
});

test('shadow worker cannot fire legacy production buy/sell jobs', async () => {
  const r = await worker.fetch(new Request('https://worker/run?job=sell-check', { method: 'POST' }), { SCHEDULER_MODE: 'monitor-only' });
  assert.equal(r.status, 404);
  const history = await worker.fetch(new Request('https://worker/monitor/log'), env);
  assert.equal(history.status, 401);
});

test('default scheduler still runs its existing job with monitor disabled', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(url); return Response.json({ status: 'checked' }); });
  const tasks = [];
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-03T05:40:00Z') }, { VERCEL_BASE: 'https://existing.vercel.app', CRON_SECRET: 'test' }, { waitUntil(p) { tasks.push(p); } });
  await Promise.all(tasks);
  assert.deepEqual(calls, ['https://existing.vercel.app/api/sell-check']);
});

test('separate shadow scheduler dispatches every-minute holdings and fifteen-minute entry research only', async t => {
  const channels = [], tasks = [];
  const binding = { idFromName: name => name, get: name => ({ fetch: async (_url, opts) => {
    channels.push({ name, channel: JSON.parse(opts.body).channel }); return Response.json({ status: 'monitored' });
  } }) };
  const ctx = { waitUntil(p) { tasks.push(p); } };
  await worker.scheduled({ scheduledTime: ms }, { ...env, SCHEDULER_MODE: 'monitor-only', ENTRY_SETUP_RESEARCH_ENABLED: 'true', UPSTOX_MONITOR: binding }, ctx);
  await Promise.all(tasks);
  assert.deepEqual(channels.map(c => c.channel).sort(), ['entries', 'positions']);
  assert.notEqual(channels[0].name, channels[1].name);
});

test('production paper scheduler uses five-minute protection and fifteen-minute entry scans, not legacy buys',async t=>{
  const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return Response.json({status:'processed',paperTrading:true});});
  const env={PAPER_SIMULATION_ENABLED:'true',VERCEL_BASE:'https://paper.vercel.app',CRON_SECRET:'fixture'};
  const ctx={waitUntil(){}};
  await worker.scheduled({scheduledTime:Date.parse('2026-11-04T04:30:00Z')},env,ctx);
  assert.deepEqual(calls,['https://paper.vercel.app/api/paper-simulation?action=scan']);
  calls.length=0;
  await worker.scheduled({scheduledTime:Date.parse('2026-11-04T04:35:00Z')},env,ctx);
  assert.deepEqual(calls,['https://paper.vercel.app/api/paper-simulation?action=risk']);
  calls.length=0;
  await worker.scheduled({scheduledTime:Date.parse('2026-11-04T10:00:00Z')},env,ctx);
  assert.equal(calls.length,0);
});
