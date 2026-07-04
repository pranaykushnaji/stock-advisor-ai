// api/backtest.js
// Replays the momentum-swing scoring for a PAST date and measures how the pick
// would have performed over the following days.
//
// HONEST LIMITATIONS (surfaced in the response so results aren't misread):
//  - Candidate pool = fixed universe (Nifty-50 + optional ?extra=), NOT the exact
//    discovery output from that day (which isn't stored historically).
//  - Momentum/volume factors ARE point-in-time accurate (price series sliced to the
//    backtest date). Fundamentals junk-filter uses CURRENT ratios (minor, 20% weight).
//  - This is an approximation for learning, not a broker-grade backtest.
//
// Usage: /api/backtest?date=2026-07-01[&extra=ULTRACEMCO,ASIANPAINT][&hold=5]

import { scoreMomentumUniverse } from './_scoring.js';
import { fetchFundamentals } from './_fundamentals.js';

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const ALIASES = { ZOMATO: 'ETERNAL', MOTHERSUMI: 'MOTHERSON', MINDTREE: 'LTIM' };
const aliasBase = (s) => { const u = (s || '').replace(/\.(NS|BO)$/i, '').toUpperCase(); return ALIASES[u] || u; };

// Compact Nifty-50 symbol set (NSE tickers) for the candidate universe.
const NIFTY50_SYMBOLS = [
  'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','BHARTIARTL','LT','SBIN','AXISBANK','KOTAKBANK',
  'HINDUNILVR','ITC','BAJFINANCE','MARUTI','SUNPHARMA','TATAMOTORS','NTPC','POWERGRID','ULTRACEMCO',
  'ASIANPAINT','TITAN','WIPRO','ADANIPORTS','COALINDIA','JSWSTEEL','TATASTEEL','M&M','NESTLEIND',
  'BAJAJ-AUTO','HINDALCO','HCLTECH','TECHM','BAJAJFINSV','ADANIENT','ONGC','GRASIM','CIPLA',
  'DRREDDY','EICHERMOT','BRITANNIA','APOLLOHOSP','DIVISLAB','HEROMOTOCO','SBILIFE','HDFCLIFE',
  'TATACONSUM','BPCL','SHRIRAMFIN','TRENT','INDUSINDBK'
];

// Fetch daily closes+volumes for a symbol. Returns full series (oldest->newest) with dates.
async function fetchSeries(base) {
  for (const sym of [`${base}.NS`, `${base}.BO`]) {
    try {
      const r = await fetchWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }, 9000);
      if (!r.ok) continue;
      const result = (await r.json())?.chart?.result?.[0];
      if (!result?.timestamp) continue;
      const meta = result.meta || {};
      if (meta.currency && meta.currency !== 'INR') continue;
      const ts = result.timestamp;
      const q = result.indicators?.quote?.[0] || {};
      const rows = ts.map((t, i) => ({
        date: new Date(t * 1000).toISOString().slice(0, 10),
        close: q.close?.[i], volume: q.volume?.[i],
      })).filter(r => r.close != null && !isNaN(r.close));
      if (rows.length < 30) continue;
      return { symbol: meta.symbol, rows };
    } catch (e) { continue; }
  }
  return null;
}

// Slice a series to end ON OR BEFORE the target date (point-in-time as of that day).
function sliceAsOf(rows, dateStr) {
  const upto = rows.filter(r => r.date <= dateStr);
  return upto.length ? upto : null;
}

export default async function handler(req, res) {
  const date = (req.query.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'provide ?date=YYYY-MM-DD' });
  }
  const holdDays = Math.min(30, Math.max(1, parseInt(req.query.hold || '5', 10)));
  const extra = (req.query.extra || '').split(',').map(s => aliasBase(s.trim())).filter(Boolean);
  const fmpKey = process.env.FMP_KEY;

  // Build candidate universe: Nifty-50 + any extras (e.g. your actual past picks).
  const universeSymbols = [...new Set([...NIFTY50_SYMBOLS, ...extra].map(aliasBase))];

  // Fetch all series in parallel (capped for serverless time).
  const fetched = await Promise.all(universeSymbols.slice(0, 55).map(async (base) => {
    const s = await fetchSeries(base);
    return s ? { base, ...s } : null;
  }));
  const withData = fetched.filter(Boolean);

  // Build the point-in-time candidate set as of `date`.
  const candidates = [];
  for (const s of withData) {
    const asOf = sliceAsOf(s.rows, date);
    if (!asOf || asOf.length < 25) continue;
    // Need forward data to measure performance.
    const forward = s.rows.filter(r => r.date > date);
    if (!forward.length) continue;
    candidates.push({
      symbol: s.base,
      fullName: s.base,
      closes: asOf.map(r => r.close),
      volumes: asOf.map(r => r.volume),
      price: asOf[asOf.length - 1].close,
      _entryDate: asOf[asOf.length - 1].date,
      _entryClose: asOf[asOf.length - 1].close,
      _forward: forward,
      fundamentals: { source: 'estimated', fields: {} }, // filled below (best-effort)
    });
  }

  if (!candidates.length) {
    return res.status(200).json({ error: 'no candidates with data as of that date', date });
  }

  // Best-effort real fundamentals (current-day approximation for the junk filter).
  await Promise.all(candidates.map(async (c) => {
    try { c.fundamentals = await fetchFundamentals(c.symbol, { fmpKey }); } catch (e) {}
  }));

  // Score with the momentum engine.
  const { ranked, rejected } = scoreMomentumUniverse(candidates);
  if (!ranked.length) {
    return res.status(200).json({ error: 'all candidates rejected by junk filter', date, rejected: rejected.map(r => r.symbol) });
  }

  const pick = ranked[0];
  const pickRow = candidates.find(c => c.symbol === pick.symbol);

  // Measure forward performance from entry close over the hold window.
  const entry = pickRow._entryClose;
  const fwd = pickRow._forward.slice(0, holdDays);
  const perf = fwd.map(r => ({ date: r.date, close: r.close, retPct: +(((r.close - entry) / entry) * 100).toFixed(2) }));
  const exitRow = fwd[fwd.length - 1];
  const holdReturn = exitRow ? +(((exitRow.close - entry) / entry) * 100).toFixed(2) : null;
  const bestDay = perf.reduce((m, p) => p.retPct > (m?.retPct ?? -999) ? p : m, null);
  const worstDay = perf.reduce((m, p) => p.retPct < (m?.retPct ?? 999) ? p : m, null);

  // Simulate the tightened sell engine over the forward window (target +8/stop -5).
  let simExit = null;
  for (let i = 0; i < fwd.length; i++) {
    const ret = ((fwd[i].close - entry) / entry) * 100;
    if (ret >= 8) { simExit = { date: fwd[i].date, retPct: +ret.toFixed(2), reason: 'target +8%' }; break; }
    if (ret <= -5) { simExit = { date: fwd[i].date, retPct: +ret.toFixed(2), reason: 'stop -5%' }; break; }
  }
  if (!simExit && exitRow) simExit = { date: exitRow.date, retPct: holdReturn, reason: `held ${fwd.length}d (max)` };

  // Top-5 leaderboard for context.
  const leaderboard = ranked.slice(0, 5).map(r => {
    const row = candidates.find(c => c.symbol === r.symbol);
    const ex = row._forward.slice(0, holdDays);
    const last = ex[ex.length - 1];
    return {
      symbol: r.symbol, composite: r.composite, verdict: r.verdict,
      momentum: r.factors.momentum, volumeRatio: r.volumeRatio,
      forwardReturn: last ? +(((last.close - row._entryClose) / row._entryClose) * 100).toFixed(2) : null,
    };
  });

  return res.status(200).json({
    date, holdDays,
    universeSize: candidates.length,
    rejectedJunk: rejected.map(r => ({ symbol: r.symbol, reasons: r.junkReasons })),
    pick: {
      symbol: pick.symbol, composite: pick.composite, verdict: pick.verdict,
      momentum: pick.factors.momentum, volume: pick.factors.volume,
      volumeRatio: pick.volumeRatio, annualizedVol: pick.annualizedVol,
      entryDate: pickRow._entryDate, entryPrice: entry,
    },
    performance: { holdReturn, bestDay, worstDay, dayByDay: perf },
    simulatedSellEngine: simExit,
    leaderboard,
    caveats: [
      'Candidate pool = Nifty-50 + extras, NOT that day\'s live discovery output.',
      'Momentum/volume are point-in-time accurate; fundamentals junk-filter uses current ratios.',
      'Approximation for learning, not a broker-grade backtest. Past results != future results.',
    ],
  });
}
