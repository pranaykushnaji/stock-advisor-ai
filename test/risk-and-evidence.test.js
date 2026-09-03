import test from 'node:test';
import assert from 'node:assert/strict';
import { seedRisk, observePrice, mergeRiskState, tradingSessionsHeld } from '../api/_position-risk.js';
import { rulesGate, exitBands, bookExit } from '../api/_sell-engine.js';
import { simSellEngine } from '../api/_exit-simulation.js';
import { expectedEdge, similarSetupStats, winProbability } from '../api/_edge.js';
import { scoreCatalyst, rememberCatalyst, recallCatalyst } from '../api/_catalyst.js';
import { rewardRisk } from '../api/_scoring.js';

const position = () => seedRisk({ entryPrice: 100, currentPrice: 100, peakPrice: 100, date: '2026-08-03' }, { stopPct: 5, trailPct: 4 });

test('frozen initial stop survives a rise in volatility and a stronger thesis', () => {
  const p = position(); p.currentPrice = 94; p.thesisScore = 90;
  const d = rulesGate(p, Array.from({ length: 30 }, (_, i) => i % 2 ? 120 : 80), { heldSessions: 3 });
  assert.equal(p.initialStopPrice, 95);
  assert.equal(d.triggerPrice, 95);
  assert.match(d.reason, /vol-stop/);
});

test('entry-day high cannot create a profit made before purchase', () => {
  const p = position();
  observePrice(p, 101, { dayHigh: 130, highDate: p.date });
  assert.equal(p.peakPrice, 101);
  observePrice(p, 102, { dayHigh: 108, highDate: '2026-08-04' });
  assert.equal(p.peakPrice, 108);
});

test('concurrent merge preserves higher peaks, tighter stops and newer quotes', () => {
  const old = { ...position(), peakPrice: 115, trailingStopPrice: 110, currentPrice: 113, lastPriceUpdate: '2026-08-04T08:00:00Z' };
  const merged = mergeRiskState(old, { ...position(), initialStopPrice: 90, peakPrice: 105, trailingStopPrice: 100,
    currentPrice: 103, lastPriceUpdate: '2026-08-04T07:00:00Z' });
  assert.equal(merged.initialStopPrice, 95);
  assert.equal(merged.peakPrice, 115);
  assert.equal(merged.trailingStopPrice, 110);
  assert.equal(merged.currentPrice, 113);
});

test('stronger thesis cannot loosen an already armed trailing price', () => {
  const p = position(); p.currentPrice = p.peakPrice = 110;
  rulesGate(p, null, { heldSessions: 3 });
  const floor = p.trailingStopPrice;
  p.thesisScore = 90;
  rulesGate(p, null, { heldSessions: 3 });
  assert.equal(p.trailingStopPrice, floor);
});

test('holding age excludes weekends, holidays and entry session', () => {
  assert.equal(tradingSessionsHeld('2026-09-11', new Date('2026-09-15T08:00:00Z')), 1);
  assert.equal(tradingSessionsHeld('2026-09-15', new Date('2026-09-15T08:00:00Z')), 0);
});

test('new high cannot retroactively trigger exit at earlier open', () => {
  const r = simSellEngine(100, [{ date: '2026-08-03', open: 100, low: 99, high: 110, close: 100 }], [], { slippageBps: 0 });
  assert.ok(r.fillPrice > 104);
  assert.doesNotMatch(r.reason, /gap/);
});

test('gap through frozen stop fills at open, not fictitious stop price', () => {
  const r = simSellEngine(100, [
    { date: '2026-08-03', open: 100, low: 99, high: 101, close: 100 },
    { date: '2026-08-04', open: 90, low: 89, high: 94, close: 92 },
  ], [], { slippageBps: 0 });
  assert.equal(r.fillPrice, 90); assert.equal(r.retPct, -10);
});

test('simulated momentum positions use momentum lane stop widths', () => {
  const rows = [{ date: '2026-08-03', open: 100, low: 95, high: 101, close: 100 }];
  const m = simSellEngine(100, rows, [], { lane: 'momentum', slippageBps: 0 });
  const c = simSellEngine(100, rows, [], { lane: 'catalyst', slippageBps: 0 });
  assert.equal(m.fillPrice, 100 * (1 - exitBands([], 'momentum').stopPct / 100));
  assert.equal(c.retPct, 0);
});

test('historical evidence can report low probability and negative expectancy without a confidence floor', () => {
  const trades = Array.from({ length: 20 }, (_, i) => ({ ticker: `T${i}`, entryDate: '2026-07-01', exitDate: '2026-07-05',
    entryLane: 'momentum', regime: 'neutral', effectiveConfidence: 75, realizedPnlPct: i < 2 ? 3 : -3 }));
  const history = similarSetupStats(trades, { lane: 'momentum', regime: 'neutral', confidence: 75, asOf: '2026-08-01' });
  const e = expectedEdge({ history, confidence: 99 });
  assert.equal(e.probability, 0.1); assert.equal(e.edgePct, -2.7);
  assert.equal(e.outOfSampleValidated, false);
});

test('thin samples and confidence alone never manufacture a probability', () => {
  assert.equal(winProbability({ confidence: 99 }), null);
  assert.equal(expectedEdge({ confidence: 99, rewardRisk: { upsidePct: 25 } }).edgePct, null);
});

test('historical calibration excludes future outcomes and duplicated trades', () => {
  const t = { ticker: 'T', entryDate: '2026-07-01', exitDate: '2026-08-01', entryLane: 'momentum', realizedPnlPct: 5 };
  assert.equal(similarSetupStats([t], { lane: 'momentum', asOf: '2026-08-01' }).samples, 0);
  assert.equal(similarSetupStats([t, t], { lane: 'momentum', asOf: '2026-08-02' }).samples, 1);
});

test('technical upside does not increase merely because risk allowance increases', () => {
  const steady = rewardRisk(Array(30).fill(100), { r1m: 0.1 }, 3);
  const volatile = rewardRisk(Array.from({ length: 30 }, (_, i) => i % 2 ? 120 : 80), { r1m: 0.1 }, 3);
  assert.equal(steady.upsidePct, 7); assert.equal(volatile.upsidePct, 7);
  assert.equal(steady.isForecast, false);
});

const cls = { catalyst_type: 'government order', direction: 'bullish', confidence: 92, impact_score: 9, evidence_article_ids: [1] };
test('an unrelated filing cannot verify the classified news event', () => {
  const s = scoreCatalyst(cls, [
    { title: 'Company wins government order', source: 'finnhub', url: 'https://www.reuters.com/a', publishedAt: Date.now() },
    { title: 'Routine board meeting', source: 'nse-filing', publishedAt: Date.now() },
  ]);
  assert.equal(s.verification, 'PARTIAL'); assert.equal(s.hasCatalyst, false);
});

test('two API providers carrying one publisher are not independent evidence', () => {
  const s = scoreCatalyst({ ...cls, evidence_article_ids: [1, 2] }, [
    { title: 'Company wins government order', source: 'finnhub', url: 'https://www.reuters.com/a', publishedAt: Date.now() },
    { title: 'Order awarded to company', source: 'marketaux', url: 'https://www.reuters.com/b', publishedAt: Date.now() },
  ]);
  assert.equal(s.sources, 1); assert.equal(s.hasCatalyst, false);
});

test('legacy verification cannot bypass new evidence checks through memory', () => {
  assert.equal(recallCatalyst({ verification: 'VERIFIED', type: 'government order', lastConfirmedMs: Date.now() }), null);
  const time = Date.now() - 48 * 3600000;
  const s = scoreCatalyst(cls, [{ title: 'Government order', source: 'nse-filing', publishedAt: time }]);
  assert.equal(rememberCatalyst(s).lastConfirmedMs, time);
});

test('booking preserves gross results and exposes separate cost scenario and execution provenance', () => {
  const t = bookExit({ ...position(), ticker: 'T', shares: 10, triggerPrice: 95 }, 94);
  assert.equal(t.realizedPnl, -60); assert.equal(t.estimatedNetPnl, -63);
  assert.equal(t.triggerPrice, 95); assert.equal(t.executionModel, 'observed-quote-paper-fill');
});
