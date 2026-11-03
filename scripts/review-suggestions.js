// Read-only, reproducible review of ALL considered stocks in archived hourly suggestions.
// Source = git snapshots + Yahoo historical 5-minute candles, not assumed pre-signal entries.
import { execFileSync } from 'node:child_process';
import { findResearchEntry, replayResearchExit } from '../api/_entry-research.js';
import { exitBands } from '../api/_sell-engine.js';

const arg = (key, fallback) => process.argv.find(x => x.startsWith(`--${key}=`))?.split('=').slice(1).join('=') || fallback;
const from = arg('from', '2026-10-28'), to = arg('to', '2026-11-03'), ref = arg('ref', 'origin/main');
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error('invalid date window');
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20000000 });
const hashes = git(['log', ref, `--since=${from}T00:00:00+05:30`, `--until=${to}T23:59:59+05:30`, '--format=%H', '--', 'data/daily-pick.json']).trim().split('\n').filter(Boolean);
const suggestions = [];
for (const sha of hashes) {
  const pick = JSON.parse(git(['show', `${sha}:data/daily-pick.json`])).pick;
  if (!pick || pick.date < from || pick.date > to) continue;
  for (const c of pick.considered || []) suggestions.push({ ...c, date: pick.date, at: pick.pickedAt, regime: pick.regime, sourceCommit: sha });
}
suggestions.sort((a, b) => a.at.localeCompare(b.at));
const grouped = new Map();
for (const s of suggestions) {
  const key = `${s.date}|${s.ticker}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(s);
}
const data = new Map();
async function chart(symbol, interval, range) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + '.NS')}?range=${range}&interval=${interval}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`historical HTTP ${r.status}`);
  const body = await r.json(), result = body.chart?.result?.[0];
  if (!result) throw new Error('historical data unavailable');
  const q = result.indicators?.quote?.[0] || {};
  return (result.timestamp || []).map((ts, i) => ({ ms: ts * 1000,
    date: new Date(ts * 1000 + 19800000).toISOString().slice(0, 10),
    open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i] }))
    .filter(b => [b.open, b.high, b.low, b.close].every(x => Number.isFinite(x) && x > 0) && Number.isFinite(b.volume));
}
const names = [...new Set(suggestions.map(s => s.ticker))];
for (let start = 0; start < names.length; start += 3) {
  await Promise.all(names.slice(start, start + 3).map(async ticker => {
    try { const [intraday, daily] = await Promise.all([chart(ticker, '5m', '1mo'), chart(ticker, '1d', '1y')]); data.set(ticker, { intraday, daily }); }
    catch (e) { data.set(ticker, { error: e.message }); }
  }));
}
const cases = [];
for (const scans of grouped.values()) {
  const first = scans[0], source = data.get(first.ticker);
  const row = { date: first.date, ticker: first.ticker, firstSuggestedAt: first.at,
    scans: scans.map(s => ({ at: s.at, regime: s.regime, relativeVolume: s.relVol,
      effectiveConfidence: s.effectiveConfidence, accumulationProxy: s.institutional, verification: s.verification })),
    sourceCommit: first.sourceCommit };
  if (source?.error) { cases.push({ ...row, error: source.error }); continue; }
  const bars = source.intraday.filter(b => b.date === first.date);
  // Use the next full candle's open after the timestamped report, never the day's open.
  const after = bars.filter(b => b.ms >= Date.parse(first.at));
  if (!after.length) { cases.push({ ...row, error: 'no post-suggestion intraday bars' }); continue; }
  const entry = after[0].open;
  const previous = source.daily.filter(b => b.date < first.date).at(-1)?.close;
  row.dayReturnPct = previous ? (bars.at(-1).close / previous - 1) * 100 : null;
  row.afterSuggestion = { referenceAt: new Date(after[0].ms).toISOString(), referencePrice: entry,
    maxGainPct: (Math.max(...after.map(b => b.high)) / entry - 1) * 100,
    maxAdversePct: (Math.min(...after.map(b => b.low)) / entry - 1) * 100,
    closeReturnPct: (after.at(-1).close / entry - 1) * 100 };
  // One preregistered experimental setup; all suggestions including losers are evaluated.
  const setup = findResearchEntry(bars, { notBefore: first.at, regime: first.regime });
  const bands = exitBands(source.daily.filter(b => b.date < first.date).map(b => b.close), 'momentum');
  row.experimental = { setup, initialStopPct: bands.stopPct,
    existingTrail: replayResearchExit(bars, setup, bands),
    tighterTrail: replayResearchExit(bars, setup, { stopPct: bands.stopPct, activationPct: 2, trailPct: 2 }) };
  cases.push(row);
}
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
console.log(JSON.stringify({ from, to, ref, generatedAt: new Date().toISOString(),
  consideredStockDays: cases.length, distinctStocks: names.length,
  summary: { available: cases.filter(c => c.afterSuggestion).length,
    positiveAfterSuggestion: cases.filter(c => c.afterSuggestion?.closeReturnPct > 0).length,
    meanAfterSuggestionClosePct: avg(cases.filter(c => c.afterSuggestion).map(c => c.afterSuggestion.closeReturnPct)),
    experimentalEntries: cases.filter(c => c.experimental?.setup.status === 'setup').length,
    existingTrailMeanNetPct: avg(cases.map(c => c.experimental?.existingTrail?.netReturnPct).filter(Number.isFinite)),
    tighterTrailMeanNetPct: avg(cases.map(c => c.experimental?.tighterTrail?.netReturnPct).filter(Number.isFinite)) },
  cases,
  limitations: ['All considered names in the chosen window, not just remembered winners. Discovery/quality rejects are outside this cohort.',
    'Daily return and maximum favorable excursion are NOT captured profits.',
    'Five-minute OHLC assumes a path; precise stop timing and fills require tick or one-minute replay.',
    'Research setup ignores the production confidence/edge gate and does not authorize a buy.',
    'Five sessions and a small sample cannot establish profitable parameters; costs use a 0.30% scenario.',
    'Experimental exits use a same-session horizon for comparison; production positions can span sessions.'],
}, null, 2));
