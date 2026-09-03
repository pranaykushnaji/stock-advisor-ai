import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNseDateMs, istDateTimeToUtcMs } from '../api/_nse-date.js';
import { tradeSessionState } from '../api/_trade-session.js';
import { alignCloseVolume } from '../api/_series.js';
import { requireCronAuth } from '../api/_cron-auth.js';
import { marketStatus } from '../api/_market-calendar.js';
import { scoreCatalyst } from '../api/_catalyst.js';
import { enforceRateLimit } from '../api/_public-api.js';

test('NSE wall-clock timestamps parse as IST, not an invalid local date', () => {
  const ms = parseNseDateMs('06-Aug-2026 14:59:48');
  assert.equal(new Date(ms).toISOString(), '2026-08-06T09:29:48.000Z');
  assert.equal(istDateTimeToUtcMs('2026-08-06', '15:30:00'), Date.parse('2026-08-06T10:00:00Z'));
});

test('official NSE filing is treated as VERIFIED catalyst', () => {
  const scored = scoreCatalyst({
    catalyst_type: 'government order', direction: 'bullish', confidence: 92,
    impact_score: 9, summary: 'official order',
  }, [{ title: '[OFFICIAL NSE FILING] Order', source: 'nse-filing', publishedAt: Date.now() }]);
  assert.equal(scored.verification, 'VERIFIED');
  assert.equal(scored.hasCatalyst, true);
  assert.ok(scored.points > 0);
});

test('daily cap includes positions already sold today and blocks same-day re-entry', () => {
  const date = '2026-09-03';
  const state = tradeSessionState(
    [{ ticker: 'AAA', date, status: 'OPEN', entryLane: 'momentum' }],
    [
      { ticker: 'BBB', entryDate: date, exitDate: date, entryLane: 'catalyst' },
      { ticker: 'CCC', entryDate: date, exitDate: date, entryLane: 'momentum' },
    ], date,
  );
  assert.equal(state.boughtCount, 3);
  assert.equal(state.momentumBuysToday, 2);
  assert.deepEqual([...state.blockedTickers].sort(), ['AAA', 'BBB', 'CCC']);
});

test('close and volume arrays remain date-aligned when a bar is missing', () => {
  assert.deepEqual(
    alignCloseVolume([100, null, 103, 104], [10, 20, null, 40]),
    { closes: [100, 104], volumes: [10, 40] },
  );
});

test('cron authentication fails closed when the secret is missing', () => {
  const old = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  let status, body;
  const res = { status(v) { status = v; return this; }, json(v) { body = v; return this; } };
  assert.equal(requireCronAuth({ headers: {}, query: {} }, res), false);
  assert.equal(status, 500);
  assert.match(body.error, /not configured/);
  if (old == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
});

test('cron authentication accepts the bearer secret and rejects a bad one', () => {
  const old = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret';
  const makeRes = () => ({ status() { return this; }, json() { return this; } });
  assert.equal(requireCronAuth({ headers: { authorization: 'Bearer test-secret' }, query: {} }, makeRes()), true);
  assert.equal(requireCronAuth({ headers: { authorization: 'Bearer wrong' }, query: {} }, makeRes()), false);
  if (old == null) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = old;
});

test('market calendar blocks weekends, listed holidays, and unconfigured years', () => {
  assert.equal(marketStatus(new Date('2026-09-06T06:00:00Z')).open, false); // Sunday IST
  assert.equal(marketStatus(new Date('2026-09-14T06:00:00Z')).open, false); // Ganesh Chaturthi
  assert.equal(marketStatus(new Date('2027-01-04T06:00:00Z')).open, false); // calendar not configured
});

test('public endpoint limiter rejects requests above its per-client budget', () => {
  const req = { headers: { 'x-forwarded-for': '192.0.2.42' }, socket: {} };
  let status = null;
  const res = {
    setHeader() {},
    status(v) { status = v; return this; },
    json() { return this; },
  };
  assert.equal(enforceRateLimit(req, res, { scope: 'unit-test', limit: 2, windowMs: 60000 }), true);
  assert.equal(enforceRateLimit(req, res, { scope: 'unit-test', limit: 2, windowMs: 60000 }), true);
  assert.equal(enforceRateLimit(req, res, { scope: 'unit-test', limit: 2, windowMs: 60000 }), false);
  assert.equal(status, 429);
});
