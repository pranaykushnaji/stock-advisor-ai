import test from 'node:test';
import assert from 'node:assert/strict';
import { laneStats, expectedEdge } from '../api/_edge.js';
import {
  SOURCES, number, escapeHTML, freshness, timestamp, sourceTime, validateData,
  mergeSuggestions, realizedAmount, positionAmount, summarizeLedger, laneEvidence,
  coverageSummary, renderSuggestions, renderPositions, renderResults, renderHealth,
} from '../desk/desk.js';

const now = Date.parse('2026-11-03T10:00:00Z');
const daily = (row = {}, pick = {}) => ({ pick: { date: '2026-11-03', pickedAt: '2026-11-03T09:30:00Z',
  noTrade: true, reason: 'Daily lane paused', considered: [{ ticker: 'AAA', relVol: 4, institutional: 73, ...row }], ...pick } });
const intra = (scan = {}, candidates = {}) => ({ date: '2026-11-03', candidates: {
  AAA: { ticker: 'AAA', sector: 'UNKNOWN', scans: [{ ts: '2026-11-03T08:30:00Z', relVol: 2,
    discoveryScore: 80, components: { flow: 97 }, missing: ['Older scan blocker'], tradeable: false, ...scan }] }, ...candidates,
} });
const trade = (overrides = {}) => ({ ticker: 'AAA', entryDate: '2026-10-01', exitDate: '2026-10-05',
  entryLane: 'momentum', realizedPnlPct: -1, realizedPnl: -10, investedAmount: 1000, ...overrides });

test('sources use public main branch and the explicit local registry, without fallback', () => {
  assert.equal(SOURCES.length, 7);
  assert.ok(SOURCES.slice(0, 5).every(s => s.url.startsWith('https://raw.githubusercontent.com/pranaykushnaji/stock-advisor-ai/main/data/')));
  assert.equal(SOURCES.at(-1).url, '../research/universe.json');
});

test('newer daily values and decision supersede old scan blockers and relative volume', () => {
  const row = mergeSuggestions(daily(), intra(), null, now)[0];
  assert.equal(row.usesDaily, true);
  assert.equal(row.relVol, 4);
  assert.equal(row.currentReason, 'Daily lane paused');
  assert.deepEqual(row.reasons, []);
  assert.deepEqual(row.scanReasons, ['Older scan blocker']);
  assert.equal(row.accumulation, 73);
  assert.equal(row.flowScore, 97);
});

test('newer scan values supersede old daily values; flow is not accumulation', () => {
  const row = mergeSuggestions(daily(), intra({ ts: '2026-11-03T09:40:00Z' }), null, now)[0];
  assert.equal(row.usesDaily, false);
  assert.equal(row.relVol, 2);
  assert.equal(row.currentReason, 'Older scan blocker');
  assert.equal(row.accumulation, null);
  assert.equal(row.flowScore, 97);
});

test('merge retains daily-only and every intraday candidate, deduplicated', () => {
  const rows = mergeSuggestions(daily({ ticker: 'DAILY' }), intra({}, { BBB: { ticker: 'BBB', scans: [] } }), null, now);
  assert.deepEqual(rows.map(r => r.ticker).sort(), ['AAA', 'BBB', 'DAILY']);
});

test('preliminary tradeable flag never produces a buy or qualification', () => {
  const row = mergeSuggestions(null, intra({ tradeable: true, missing: [] }), null, now)[0];
  assert.equal(row.status, 'Watch');
  assert.equal(row.price, null);
  assert.equal(row.vwap, null);
  assert.match(renderSuggestions([row]), /preliminary scan only; no entry is authorized/);
});

test('recorded blockers and expiry are explicit; no fabricated trigger or stop', () => {
  const row = mergeSuggestions(null, intra(), null, now + 86400000)[0];
  assert.equal(row.expired, true);
  assert.equal(row.expiresAt, '2026-11-03T15:30:00+05:30');
  assert.equal(row.trigger, null); assert.equal(row.stop, null);
  assert.match(renderSuggestions([row]), /Expired/);
  assert.match(renderSuggestions([row]), /scans.missing/);
});

test('registry sectors, counts and mappings remain separate from snapshot coverage', () => {
  const registry = { summary: { members: 3, mapped: 2, unmapped: 1, mid: 1, small: 1 }, members: [
    { symbol: 'AAA', sector: 'Healthcare', marketCapBucket: 'mid', instrumentKey: 'NSE_EQ|AAA', mappingStatus: 'mapped' },
    { symbol: 'BBB', sector: 'IT', marketCapBucket: 'small', instrumentKey: 'NSE_EQ|BBB' },
    { symbol: 'DUMMY', sector: 'UNKNOWN', mappingStatus: 'unmapped' },
  ] };
  const rows = mergeSuggestions(daily(), intra(), null, now, registry);
  assert.equal(rows[0].sector, 'Healthcare');
  const coverage = coverageSummary({ diag: { universeCount: 214, indicesOk: 1, universeIndicesScanned: 8,
    indexRows: { 'NIFTY 500': 0, 'SECURITIES IN F&O': 214 } }, data: {} }, registry, rows);
  assert.equal(coverage.registryCount, 3); assert.equal(coverage.actualCount, 214);
  assert.equal(coverage.mapped, 2); assert.equal(coverage.unmapped, 1);
  assert.equal(coverage.indicesOk, 1); assert.equal(coverage.attempted, 8);
  assert.equal(coverage.missingSector, 1); assert.deepEqual(coverage.failed, ['NIFTY 500']);
});

test('ledger sums rupees and open shares, never averaging return percentages', () => {
  const summary = summarizeLedger([{ realizedPnl: 100, investedAmount: 1000 },
    { shares: 2, entryPrice: 100, exitPrice: 90 }], [{ shares: 3, entryPrice: 100, currentPrice: 105 }]);
  assert.equal(summary.gross, 80); assert.equal(summary.unrealized, 15);
  assert.equal(summary.combined, 95); assert.equal(summary.wins, 1);
  assert.equal(summary.estimatedCosts, 3.6); assert.equal(summary.estimatedNet, 76.4);
  assert.equal(realizedAmount({ realizedPnl: 19.99, shares: 2, entryPrice: 100, exitPrice: 110 }), 19.99);
  assert.equal(positionAmount({ shares: 2, entryPrice: 100, currentPrice: 110 }), 20);
});

test('missing source is not zero; missing shares or capital cannot create net P&L', () => {
  assert.equal(summarizeLedger(null, null).gross, null);
  assert.equal(summarizeLedger(null, null).unrealized, null);
  const partial = summarizeLedger([{ realizedPnlPct: 5 }, { realizedPnl: 20 }], [{ entryPrice: 100, currentPrice: 110 }]);
  assert.equal(partial.missingRealized, 1); assert.equal(partial.missingOpen, 1);
  assert.equal(partial.estimatedNet, null); assert.equal(partial.combined, null);
  assert.equal(partial.estimatedCosts, 0);
});

test('lane evidence shares gate exclusions, duplicate order and as-of cutoff', () => {
  const rows = [trade(), trade({ realizedPnlPct: 90 }), trade({ ticker: 'VOID', voided: true }),
    trade({ ticker: 'SYN', synthetic: true }), trade({ ticker: 'BACK', backdated: true }),
    trade({ ticker: 'TODAY', exitDate: '2026-11-03' }), trade({ ticker: 'FUTURE', exitDate: '2026-11-04' }),
    trade({ ticker: 'BAD', realizedPnlPct: NaN }), trade({ ticker: 'NOEXIT', exitDate: null }),
    ...Array.from({ length: 20 }, (_, i) => trade({ ticker: `T${i}`, realizedPnlPct: i % 2 ? 2 : -1 }))];
  const history = laneStats(rows, 'momentum', '2026-11-03');
  const evidence = laneEvidence(rows, 'momentum', '2026-11-03');
  assert.equal(evidence.count, 21);
  assert.equal(evidence.count, history.samples);
  assert.equal(evidence.edgePct, expectedEdge({ history }).edgePct);
  assert.ok(Math.abs(evidence.meanNetPct - (history.meanReturnPct - 0.3)) < 1e-10);
  assert.equal(laneEvidence([trade({ investedAmount: null })], 'momentum', '2026-11-03').meanNetPct, null);
});

test('freshness does not confuse latest exit activity with publication time', () => {
  assert.equal(freshness(null, now).label, 'Age unknown');
  assert.ok(freshness('2026-10-30T09:30:00Z', now).stale);
  assert.ok(freshness('2027-01-01T00:00:00Z', now).stale);
  assert.equal(timestamp('2026-11-03'), Date.parse('2026-11-02T18:30:00Z'));
  assert.match(sourceTime('realized', { trades: [trade()] }).kind, /file age unknown/);
});

test('unavailable and unsafe source values are visible and safely escaped', () => {
  const ledger = summarizeLedger(null, null);
  assert.match(renderResults(null, ledger), /Results unavailable/);
  assert.match(renderPositions(null, ledger), /Positions unavailable/);
  assert.throws(() => validateData('realized', {}));
  assert.throws(() => validateData('universe', { members: [] }));
  assert.equal(number(null), null); assert.equal(number(''), null); assert.equal(number(false), null);
  assert.equal(escapeHTML('<script>"&'), '&lt;script&gt;&quot;&amp;');
  const coverage = coverageSummary(null, null);
  const html = renderHealth([{ ...SOURCES[0], data: null, error: 'HTTP 503 <bad>', loadedAt: null }], coverage, now);
  assert.match(html, /Unavailable/); assert.match(html, /HTTP 503 &lt;bad&gt;/);
  assert.match(html, /no silent local fallback/);
  assert.match(html, /Stocks in latest snapshot/);
  assert.match(html, /detailed research has its own shortlist/);
  assert.doesNotMatch(html, /Actually scanned symbols|actual scan coverage/);
});
