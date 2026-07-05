// api/backtest.js
// Replays the momentum-swing scoring for PAST date(s) and measures forward performance.
//
// TWO MODES:
//  (A) Single date:  /api/backtest?date=2026-07-01[&extra=SYM,SYM][&hold=5]
//      -> detailed one-day report (pick, day-by-day, sim sell engine, leaderboard).
//  (B) Range + variants: /api/backtest?from=2026-06-01&to=2026-06-30[&hold=5][&step=1]
//      -> loops trading days in range, runs MULTIPLE scoring variants per day,
//         aggregates win rate / avg return / avg-vs-Nifty / #1-beats-shortlist.
//
// HONEST LIMITATIONS (surfaced in the response so results aren't misread):
//  - Candidate pool = fixed universe (Nifty-50 + optional ?extra=), NOT the exact
//    discovery output from that day (which isn't stored historically).
//  - Momentum/volume factors ARE point-in-time accurate (price series sliced to the
//    backtest date). Fundamentals junk-filter uses CURRENT ratios (minor).
//  - Variant re-ranking reuses the SAME point-in-time percentile factor scores; only
//    the composite WEIGHTS differ between variants, so the comparison is apples-to-apples.
//  - This is an approximation for learning, not a broker-grade backtest.

import { scoreMomentumUniverse } from './_scoring.js';
import { fetchFundamentals } from './_fundamentals.js';
import { SELL_RULES } from './_sell-engine.js';

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

// ---- Scoring variants: same point-in-time factor ranks, different composite weights ----
// Each variant's weights are renormalized over whatever factors are present.
// 'composite' MUST mirror the live MOMENTUM_WEIGHTS so the backtest tracks production.
const VARIANTS = {
  composite:            { momentum: 0.45, technicals: 0.15, quality: 0.15, volume: 0.15, lowVol: 0.10 },
  pure_momentum:        { momentum: 1.00 },
  momentum_volume:      { momentum: 0.70, volume: 0.30 },
  momentum_technicals:  { momentum: 0.60, technicals: 0.40 },
};

// Recompute a composite from an already-scored stock's per-factor percentile scores
// using an arbitrary weight map. Renormalizes over present factors (mirrors the
// production momentumComposite behaviour so a missing factor doesn't zero the score).
function recomposite(factors, weights) {
  const parts = [];
  for (const [k, w] of Object.entries(weights)) {
    if (factors[k] != null && isFinite(factors[k])) parts.push({ v: factors[k], w });
  }
  if (!parts.length) return null;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  return +(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum).toFixed(1);
}

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

// Fetch the Nifty-50 index series (^NSEI) for benchmark-relative returns.
async function fetchBenchmark() {
  try {
    const r = await fetchWithTimeout(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent('^NSEI')}?range=2y&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }, 9000);
    if (!r.ok) return null;
    const result = (await r.json())?.chart?.result?.[0];
    if (!result?.timestamp) return null;
    const q = result.indicators?.quote?.[0] || {};
    return result.timestamp.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: q.close?.[i],
    })).filter(r => r.close != null && !isNaN(r.close));
  } catch (e) { return null; }
}

// Slice a series to end ON OR BEFORE the target date (point-in-time as of that day).
function sliceAsOf(rows, dateStr) {
  const upto = rows.filter(r => r.date <= dateStr);
  return upto.length ? upto : null;
}

// Nifty return over the same forward window (entryDate exclusive -> hold days).
function benchForwardReturn(bench, entryDate, holdDays) {
  if (!bench) return null;
  const asOf = bench.filter(r => r.date <= entryDate);
  const fwd = bench.filter(r => r.date > entryDate).slice(0, holdDays);
  if (!asOf.length || !fwd.length) return null;
  const entry = asOf[asOf.length - 1].close;
  const exit = fwd[fwd.length - 1].close;
  return +(((exit - entry) / entry) * 100).toFixed(2);
}

// Faithfully simulate the PRODUCTION sell engine over a forward window.
// Mirrors rulesGate() in _sell-engine.js: target -> stop -> max-hold -> momentum-fade,
// evaluated in that precedence order, using the SAME thresholds (imported SELL_RULES)
// so the backtest can never drift from live rules.
//
// Key correctness detail vs the live gate: daysHeld() in production measures to
// wall-clock today, which is meaningless in a replay. Here "held" is measured along
// the SIMULATED timeline: after forward day index i, the position has been held i+1
// trading rows. The momentum-fade 1-week window uses the trailing close series
// reconstructed as-of each forward day (entry history + forward closes seen so far),
// matching how the live cron passes recentCloses.
//
// entryCloses = the point-in-time close series up to and including entry day (oldest->newest).
function simSellEngine(entry, fwd, entryCloses = null) {
  const trail = Array.isArray(entryCloses) ? entryCloses.slice() : [];
  for (let i = 0; i < fwd.length; i++) {
    const close = fwd[i].close;
    trail.push(close);
    const ret = ((close - entry) / entry) * 100;
    const held = i + 1; // trading rows held so far along the simulated timeline
    // Precedence must match rulesGate exactly.
    if (ret >= SELL_RULES.TARGET_PCT) return { date: fwd[i].date, retPct: +ret.toFixed(2), reason: `target hit (+${ret.toFixed(1)}%)`, day: held };
    if (ret <= SELL_RULES.STOP_PCT) return { date: fwd[i].date, retPct: +ret.toFixed(2), reason: `stop-loss (${ret.toFixed(1)}%)`, day: held };
    if (held >= SELL_RULES.MAX_HOLD_DAYS) return { date: fwd[i].date, retPct: +ret.toFixed(2), reason: `max hold ${held}d`, day: held };
    // Momentum-fade: same window math as production (last vs close 6 rows back),
    // only after day 2, only if the trailing series is long enough.
    if (trail.length >= 6) {
      const last = trail[trail.length - 1];
      const wkAgo = trail[trail.length - 6];
      if (wkAgo > 0) {
        const wkTrend = ((last - wkAgo) / wkAgo) * 100;
        if (held >= 2 && wkTrend <= -3) return { date: fwd[i].date, retPct: +ret.toFixed(2), reason: `momentum faded (1wk ${wkTrend.toFixed(1)}%)`, day: held };
      }
    }
  }
  const last = fwd[fwd.length - 1];
  return last ? { date: last.date, retPct: +(((last.close - entry) / entry) * 100).toFixed(2), reason: `held ${fwd.length}d (window end)`, day: fwd.length } : null;
}

// Build the point-in-time scored universe as of `date`. Returns { scored, candidates } or null.
// `scored` = full ranked output (each carries .factors for variant recomposition).
function buildScoredUniverse(withData, date) {
  const candidates = [];
  for (const s of withData) {
    const asOf = sliceAsOf(s.rows, date);
    if (!asOf || asOf.length < 25) continue;
    const forward = s.rows.filter(r => r.date > date);
    if (!forward.length) continue;
    candidates.push({
      symbol: s.base, fullName: s.base,
      closes: asOf.map(r => r.close),
      volumes: asOf.map(r => r.volume),
      price: asOf[asOf.length - 1].close,
      _entryDate: asOf[asOf.length - 1].date,
      _entryClose: asOf[asOf.length - 1].close,
      _forward: forward,
      fundamentals: s._fundamentals || { source: 'estimated', fields: {} },
    });
  }
  if (!candidates.length) return null;
  const { ranked, rejected } = scoreMomentumUniverse(candidates);
  if (!ranked.length) return null;
  // Attach forward rows onto each ranked entry for measurement.
  const bySym = new Map(candidates.map(c => [c.symbol, c]));
  for (const r of ranked) { r._row = bySym.get(r.symbol); }
  return { ranked, rejected, candidates };
}

// For one variant on one day: re-rank scored stocks by the variant composite, pick #1,
// measure forward hold-return, sim-sell return, vs-Nifty, and #1-vs-shortlist-average.
function evalVariantForDay(ranked, weights, holdDays, bench) {
  const reranked = ranked
    .map(r => ({ r, comp: recomposite(r.factors, weights) }))
    .filter(x => x.comp != null)
    .sort((a, b) => b.comp - a.comp);
  if (!reranked.length) return null;

  const measure = (row) => {
    const fwd = row._forward.slice(0, holdDays);
    const last = fwd[fwd.length - 1];
    const holdReturn = last ? +(((last.close - row._entryClose) / row._entryClose) * 100).toFixed(2) : null;
    const sim = simSellEngine(row._entryClose, fwd, row.closes);
    return { holdReturn, simReturn: sim ? sim.retPct : null, simReason: sim ? sim.reason : null, entryDate: row._entryDate };
  };

  const top = reranked[0].r;
  const topM = measure(top._row);
  // Shortlist = top 5 by this variant; average forward hold-return.
  const shortlist = reranked.slice(0, 5).map(x => measure(x.r._row)).filter(m => m.holdReturn != null);
  const shortlistAvg = shortlist.length
    ? +(shortlist.reduce((a, m) => a + m.holdReturn, 0) / shortlist.length).toFixed(2) : null;
  const benchRet = benchForwardReturn(bench, topM.entryDate, holdDays);

  return {
    pick: top.symbol,
    composite: reranked[0].comp,
    holdReturn: topM.holdReturn,
    simReturn: topM.simReturn,
    benchReturn: benchRet,
    vsBench: (topM.holdReturn != null && benchRet != null) ? +(topM.holdReturn - benchRet).toFixed(2) : null,
    shortlistAvg,
    topBeatShortlist: (topM.holdReturn != null && shortlistAvg != null) ? topM.holdReturn >= shortlistAvg : null,
  };
}

// Enumerate ISO dates from `from` to `to` inclusive (calendar days; non-trading days
// simply yield no candidates and are skipped in aggregation).
function enumerateDates(from, to, step) {
  const out = [];
  let d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + step * 86400000);
  }
  return out;
}

export default async function handler(req, res) {
  const fmpKey = process.env.FMP_KEY;
  const holdDays = Math.min(30, Math.max(1, parseInt(req.query.hold || '5', 10)));
  const extra = (req.query.extra || '').split(',').map(s => aliasBase(s.trim())).filter(Boolean);
  const universeSymbols = [...new Set([...NIFTY50_SYMBOLS, ...extra].map(aliasBase))];

  const from = (req.query.from || '').slice(0, 10);
  const to = (req.query.to || '').slice(0, 10);
  const rangeMode = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  const singleDate = (req.query.date || '').slice(0, 10);

  if (!rangeMode && !/^\d{4}-\d{2}-\d{2}$/.test(singleDate)) {
    return res.status(400).json({ error: 'provide ?date=YYYY-MM-DD OR ?from=YYYY-MM-DD&to=YYYY-MM-DD' });
  }

  // Fetch all series ONCE (2y range covers any backtest date), reused across all days.
  const fetched = await Promise.all(universeSymbols.slice(0, 55).map(async (base) => {
    const s = await fetchSeries(base);
    return s ? { base, ...s } : null;
  }));
  const withData = fetched.filter(Boolean);
  if (!withData.length) return res.status(200).json({ error: 'no price data fetched' });

  // Best-effort current fundamentals (junk-filter approximation), fetched once.
  await Promise.all(withData.map(async (s) => {
    try { s._fundamentals = await fetchFundamentals(s.base, { fmpKey }); } catch (e) {}
  }));

  const bench = await fetchBenchmark();

  // ---------------- RANGE + VARIANTS MODE ----------------
  if (rangeMode) {
    const step = Math.min(7, Math.max(1, parseInt(req.query.step || '1', 10)));
    const dates = enumerateDates(from, to, step);
    // Accumulator per variant.
    const acc = {};
    for (const name of Object.keys(VARIANTS)) {
      acc[name] = { trades: [], picks: [] };
    }
    let tradingDays = 0;

    for (const date of dates) {
      const built = buildScoredUniverse(withData, date);
      if (!built) continue; // non-trading day or no eligible candidates
      tradingDays++;
      for (const [name, weights] of Object.entries(VARIANTS)) {
        const ev = evalVariantForDay(built.ranked, weights, holdDays, bench);
        if (!ev || ev.holdReturn == null) continue;
        acc[name].trades.push(ev);
        acc[name].picks.push({ date, ...ev });
      }
    }

    // Aggregate per variant.
    const summary = {};
    for (const [name, data] of Object.entries(acc)) {
      const t = data.trades;
      const n = t.length;
      if (!n) { summary[name] = { trades: 0 }; continue; }
      const sum = (f) => t.reduce((a, x) => a + (f(x) ?? 0), 0);
      const cnt = (pred) => t.filter(pred).length;
      const holdWins = cnt(x => x.holdReturn > 0);
      const simWins = cnt(x => x.simReturn != null && x.simReturn > 0);
      const beatBench = cnt(x => x.vsBench != null && x.vsBench > 0);
      const beatShort = cnt(x => x.topBeatShortlist === true);
      const beatShortEligible = cnt(x => x.topBeatShortlist != null);
      summary[name] = {
        trades: n,
        avgHoldReturn: +(sum(x => x.holdReturn) / n).toFixed(2),
        avgSimReturn: +(sum(x => x.simReturn) / n).toFixed(2),
        winRateHold: +((holdWins / n) * 100).toFixed(1),
        winRateSim: +((simWins / n) * 100).toFixed(1),
        avgVsNifty: +(sum(x => x.vsBench) / n).toFixed(2),
        beatNiftyRate: +((beatBench / n) * 100).toFixed(1),
        topBeatsShortlistRate: beatShortEligible ? +((beatShort / beatShortEligible) * 100).toFixed(1) : null,
      };
    }

    // Rank variants by avg sim-engine return (the metric closest to how it'd actually trade).
    const leaderboard = Object.entries(summary)
      .filter(([, s]) => s.trades > 0)
      .sort((a, b) => (b[1].avgSimReturn ?? -999) - (a[1].avgSimReturn ?? -999))
      .map(([name, s], i) => ({ rank: i + 1, variant: name, avgSimReturn: s.avgSimReturn, winRateSim: s.winRateSim, avgVsNifty: s.avgVsNifty }));

    return res.status(200).json({
      mode: 'range_variants',
      from, to, step, holdDays,
      calendarDays: dates.length,
      tradingDays,
      universeSize: withData.length,
      benchmark: bench ? 'NIFTY50 (^NSEI)' : 'unavailable',
      variantWeights: VARIANTS,
      summary,
      leaderboard,
      picksByVariant: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.picks])),
      caveats: [
        'Universe = Nifty-50 + extras, NOT that day\'s live discovery output.',
        'All variants share point-in-time factor ranks; only composite weights differ.',
        'Fundamentals junk-filter uses CURRENT ratios (not point-in-time).',
        'Small samples (few trading days) are noise. Interpret >20 trades cautiously, <10 not at all.',
        'Approximation for learning, not a broker-grade backtest. Past != future.',
      ],
    });
  }

  // ---------------- SINGLE-DATE MODE (original detailed report) ----------------
  const date = singleDate;
  const built = buildScoredUniverse(withData, date);
  if (!built) {
    return res.status(200).json({ error: 'no candidates / all rejected as of that date', date });
  }
  const { ranked, rejected } = built;
  const pick = ranked[0];
  const pickRow = pick._row;
  const entry = pickRow._entryClose;
  const fwd = pickRow._forward.slice(0, holdDays);
  const perf = fwd.map(r => ({ date: r.date, close: r.close, retPct: +(((r.close - entry) / entry) * 100).toFixed(2) }));
  const exitRow = fwd[fwd.length - 1];
  const holdReturn = exitRow ? +(((exitRow.close - entry) / entry) * 100).toFixed(2) : null;
  const bestDay = perf.reduce((m, p) => p.retPct > (m?.retPct ?? -999) ? p : m, null);
  const worstDay = perf.reduce((m, p) => p.retPct < (m?.retPct ?? 999) ? p : m, null);
  const simExit = simSellEngine(entry, fwd, pickRow.closes);
  const benchRet = benchForwardReturn(bench, pickRow._entryDate, holdDays);

  const leaderboard = ranked.slice(0, 5).map(r => {
    const ex = r._row._forward.slice(0, holdDays);
    const last = ex[ex.length - 1];
    return {
      symbol: r.symbol, composite: r.composite, verdict: r.verdict,
      momentum: r.factors.momentum, volumeRatio: r.volumeRatio,
      forwardReturn: last ? +(((last.close - r._row._entryClose) / r._row._entryClose) * 100).toFixed(2) : null,
    };
  });

  return res.status(200).json({
    mode: 'single_date',
    date, holdDays,
    universeSize: built.candidates.length,
    benchmark: bench ? 'NIFTY50 (^NSEI)' : 'unavailable',
    rejectedJunk: rejected.map(r => ({ symbol: r.symbol, reasons: r.junkReasons })),
    pick: {
      symbol: pick.symbol, composite: pick.composite, verdict: pick.verdict,
      momentum: pick.factors.momentum, volume: pick.factors.volume,
      volumeRatio: pick.volumeRatio, annualizedVol: pick.annualizedVol,
      entryDate: pickRow._entryDate, entryPrice: entry,
    },
    performance: { holdReturn, vsNifty: (holdReturn != null && benchRet != null) ? +(holdReturn - benchRet).toFixed(2) : null, niftyReturn: benchRet, bestDay, worstDay, dayByDay: perf },
    simulatedSellEngine: simExit,
    leaderboard,
    caveats: [
      'Candidate pool = Nifty-50 + extras, NOT that day\'s live discovery output.',
      'Momentum/volume are point-in-time accurate; fundamentals junk-filter uses current ratios.',
      'Approximation for learning, not a broker-grade backtest. Past results != future results.',
    ],
  });
}
