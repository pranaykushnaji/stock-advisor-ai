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

import { scoreMomentumUniverse, scoreQualityMomentum, rewardRisk, computeShortReturns } from './_scoring.js';
import { classifyRegimeV2, regimeGates } from './_market-regime.js';
import { fetchFundamentals } from './_fundamentals.js';
import { SELL_RULES, exitBands } from './_sell-engine.js';
import { ema } from './_indicators.js';
import { sectorStrength } from './_sector.js';

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const ALIASES = { ZOMATO: 'ETERNAL', MOTHERSUMI: 'MOTHERSON', MINDTREE: 'LTIM' };
const aliasBase = (s) => { const u = (s || '').replace(/\.(NS|BO)$/i, '').toUpperCase(); return ALIASES[u] || u; };

// Simulated execution friction: every modelled exit fills this much WORSE than its trigger
// (0.15%), approximating spread + slippage. Bigger for thin midcaps — tune via ?slippage=<bps>.
const SLIPPAGE_BPS = 15;

// Broader / midcap NSE universe — where short-term momentum actually lives. This is the real
// hunting ground for the swing strategy, vs. the slow Nifty-50. Select with ?universe=midcap
// (or ?universe=all to combine). Names span sectors; a few may be large-cap now — fine, the
// point is more volatile, higher-momentum names than the index heavyweights.
const MIDCAP_SYMBOLS = [
  'PERSISTENT','COFORGE','MPHASIS','OFSS','LTTS','MAXHEALTH','FORTIS','ASHOKLEY','BHARATFORG',
  'MRF','BALKRISIND','TVSMOTOR','CUMMINSIND','ABB','SIEMENS','POLYCAB','DIXON','VOLTAS','HAVELLS',
  'CROMPTON','PIIND','SRF','DEEPAKNTR','AARTIIND','DALBHARAT','AMBUJACEM','ACC','JUBLFOOD','PAGEIND',
  'GODREJPROP','OBEROIRLTY','PHOENIXLTD','PRESTIGE','LODHA','AUBANK','BANKBARODA','PNB','CANBK',
  'FEDERALBNK','INDHOTEL','PETRONET','IGL','TATAPOWER','TORNTPOWER','NHPC','IRCTC','IRFC','RVNL',
  'HAL','BEL','MAZDOCK','CONCOR','NYKAA','PAYTM','POLICYBZR','CHOLAFIN','MUTHOOTFIN','RECLTD','PFC',
  'TATACOMM','INDUSTOWER','ADANIPOWER','GAIL','HINDPETRO','IOC','ABCAPITAL','GMRAIRPORT','SUZLON',
  'IDFCFIRSTB','ETERNAL','NMDC','SAIL','VEDL','JINDALSTEL','APLAPOLLO','LICHSGFIN','TATAELXSI','KPITTECH',
];

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
  composite:              { momentum: 0.70, volume: 0.30 },  // == live MOMENTUM_WEIGHTS (post-reweight)
  legacy_blend:           { momentum: 0.45, technicals: 0.15, quality: 0.15, volume: 0.15, lowVol: 0.10 }, // pre-reweight, for before/after
  pure_momentum:          { momentum: 1.00 },
  momentum_technicals:    { momentum: 0.60, technicals: 0.40 },
  momentum_volume_lowvol: { momentum: 0.60, volume: 0.25, lowVol: 0.15 }, // does taming volatility help on midcaps?
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
        open: q.open?.[i], high: q.high?.[i], low: q.low?.[i],
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
      open: q.open?.[i],
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
  const fwd = bench.filter(r => r.date > entryDate).slice(0, holdDays);
  if (!fwd.length) return null;
  const entry = fwd[0].open ?? fwd[0].close;
  const exit = fwd[fwd.length - 1].close;
  return +(((exit - entry) / entry) * 100).toFixed(2);
}

// Simulate the production sell engine over a forward window, WITH realistic execution.
// Same deterministic stop/trail/review thresholds as rulesGate(), modelled against daily OHLC
// and net of slippage so the numbers
// aren't rosier than real trading would be:
//   • STOP is checked before TARGET (conservative: if a volatile day touches both, assume
//     you were stopped — the opposite of production's target-first precedence, on purpose).
//   • Gap risk: if the day OPENS beyond the stop/target, you fill at the OPEN (a gap-down
//     through the stop fills WORSE than -5%), not at the trigger price.
//   • Slippage: every exit fills `slippageBps` worse than its trigger price.
// "held" is measured along the simulated timeline (i+1 rows). The momentum-fade 1-week
// window uses the trailing close series reconstructed as-of each forward day.
// entryCloses = point-in-time close series up to and including entry day (oldest->newest).
function simSellEngine(entry, fwd, entryCloses = null, opts = {}) {
  const slipFrac = (opts.slippageBps ?? SLIPPAGE_BPS) / 10000;
  const { stopPct, trailPct } = exitBands(entryCloses); // same vol-adaptive bands as production
  const stopPrice = entry * (1 - stopPct / 100);
  const trailFrac = trailPct / 100;
  const trail = Array.isArray(entryCloses) ? entryCloses.slice() : [];
  // A sell fills slightly below the trigger price -> slippage always reduces the return.
  const netRet = (fillPrice) => +((((fillPrice * (1 - slipFrac)) - entry) / entry) * 100).toFixed(2);
  let peak = entry;
  for (let i = 0; i < fwd.length; i++) {
    const row = fwd[i];
    const o = row.open ?? row.close, hi = row.high ?? row.close, lo = row.low ?? row.close, c = row.close;
    trail.push(c);
    const held = i + 1;
    // 1. Initial vol-stop (checked first, conservative). Gap-down through it fills at the open.
    if (o <= stopPrice) return { date: row.date, retPct: netRet(o), reason: `stop gap-down (open ₹${o.toFixed(2)})`, day: held };
    if (lo <= stopPrice) return { date: row.date, retPct: netRet(stopPrice), reason: `vol-stop (-${stopPct.toFixed(1)}%)`, day: held };
    // 2. Trailing stop — arm once the peak (incl. today's high) is up more than a trail band.
    peak = Math.max(peak, hi);
    if ((peak - entry) / entry * 100 >= trailPct) {
      const trig = peak * (1 - trailFrac);
      if (o <= trig) return { date: row.date, retPct: netRet(o), reason: `trailing gap (open ₹${o.toFixed(2)})`, day: held };
      if (lo <= trig) return { date: row.date, retPct: netRet(trig), reason: `trailing stop (-${trailPct.toFixed(1)}% from peak)`, day: held };
    }
    // 3. Review date, matching production's deterministic health checks. Historical thesis
    // changes are unavailable, so the thesis component remains neutral/intact.
    const reviewDate = opts.lane === 'momentum' ? 7 : SELL_RULES.MAX_HOLD_DAYS;
    if (held >= reviewDate) {
      const failed = [];
      const wkAgo = trail.length >= 6 ? trail[trail.length - 6] : null;
      if (wkAgo > 0 && ((c - wkAgo) / wkAgo * 100) <= -2) failed.push('1wk trend weak');
      const e20 = trail.length >= 20 ? ema(trail, 20) : null;
      if (e20 != null && c < e20) failed.push('below 20-EMA');
      const hi52 = Math.max(...trail.slice(-252));
      const room = hi52 > 0 ? ((hi52 - c) / c) * 100 : null;
      const rr = rewardRisk(trail, computeShortReturns(trail), room);
      if ((rr?.rr ?? 0) < 1.2) failed.push(`RR ${rr?.rr ?? 'n/a'}<1.2`);
      if (failed.length) return { date: row.date, retPct: netRet(c), reason: `review day ${held}: ${failed.join(', ')}`, day: held };
    }
    // 4. Momentum-fade.
    if (trail.length >= 6) {
      const last = trail[trail.length - 1];
      const wkAgo = trail[trail.length - 6];
      if (wkAgo > 0) {
        const wkTrend = ((last - wkAgo) / wkAgo) * 100;
        if (held >= 2 && wkTrend <= -3) return { date: row.date, retPct: netRet(c), reason: `momentum faded (1wk ${wkTrend.toFixed(1)}%)`, day: held };
      }
    }
  }
  const last = fwd[fwd.length - 1];
  return last ? { date: last.date, retPct: netRet(last.close), reason: `held ${fwd.length}d (window end)`, day: fwd.length } : null;
}

// LEGACY fixed-rule exit (+8% target / -5% stop / 7d max-hold + momentum-fade), with the
// same gap + slippage modelling — kept ONLY so the backtest can A/B the old rules against the
// new vol-adaptive ones in the same run (?exit=fixed). Production uses simSellEngine.
function simSellEngineFixed(entry, fwd, entryCloses = null, opts = {}) {
  const L = { TARGET: 8, STOP: -5, MAXHOLD: 7 };
  const slipFrac = (opts.slippageBps ?? SLIPPAGE_BPS) / 10000;
  const target = entry * (1 + L.TARGET / 100), stop = entry * (1 + L.STOP / 100);
  const trail = Array.isArray(entryCloses) ? entryCloses.slice() : [];
  const netRet = (f) => +((((f * (1 - slipFrac)) - entry) / entry) * 100).toFixed(2);
  for (let i = 0; i < fwd.length; i++) {
    const row = fwd[i];
    const o = row.open ?? row.close, hi = row.high ?? row.close, lo = row.low ?? row.close, c = row.close;
    trail.push(c);
    const held = i + 1;
    if (o <= stop) return { date: row.date, retPct: netRet(o), reason: `stop gap-down`, day: held };
    if (lo <= stop) return { date: row.date, retPct: netRet(stop), reason: `stop-loss (-5%)`, day: held };
    if (o >= target) return { date: row.date, retPct: netRet(o), reason: `target gap-up`, day: held };
    if (hi >= target) return { date: row.date, retPct: netRet(target), reason: `target hit (+8%)`, day: held };
    if (held >= L.MAXHOLD) return { date: row.date, retPct: netRet(c), reason: `max hold ${held}d`, day: held };
    if (trail.length >= 6) {
      const last = trail[trail.length - 1], wkAgo = trail[trail.length - 6];
      if (wkAgo > 0) { const wk = ((last - wkAgo) / wkAgo) * 100; if (held >= 2 && wk <= -3) return { date: row.date, retPct: netRet(c), reason: `momentum faded`, day: held }; }
    }
  }
  const last = fwd[fwd.length - 1];
  return last ? { date: last.date, retPct: netRet(last.close), reason: `held ${fwd.length}d (window end)`, day: fwd.length } : null;
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
      _asOfRow: asOf[asOf.length - 1],
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
function evalVariantForDay(ranked, weights, holdDays, bench, opts = {}) {
  const reranked = ranked
    .map(r => ({ r, comp: recomposite(r.factors, weights) }))
    .filter(x => x.comp != null)
    .sort((a, b) => b.comp - a.comp);
  if (!reranked.length) return null;

  const measure = (row) => {
    const fwd = row._forward.slice(0, holdDays);
    const last = fwd[fwd.length - 1];
    // Daily history cannot reproduce a 10:00/14:00 fill. Execute at the NEXT session's open,
    // which is observable only after the signal and avoids same-day lookahead bias.
    const execution = fwd[0] ? (fwd[0].open ?? fwd[0].close) : null;
    const holdReturn = last && execution ? +(((last.close - execution) / execution) * 100).toFixed(2) : null;
    const sim = execution ? (opts.simFn || simSellEngine)(execution, fwd, row.closes, opts) : null;
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

// Point-in-time benchmark close series as of `date` (for regime + relative strength).
function benchClosesAsOf(bench, date) {
  if (!bench) return null;
  return bench.filter(r => r.date <= date).map(r => r.close).filter(v => v != null && !isNaN(v));
}

// LIVE-ENGINE variant: score the day's candidates with the SAME deterministic scorer production
// uses (scoreQualityMomentum → multi-signal confidence + reward/risk), classify the market regime
// from the point-in-time Nifty series, and apply the regime-adaptive confidence/RR gates. This is
// what keeps the backtest synchronized with production for the parts that CAN be replayed on
// history. What CANNOT (and is therefore neutralized here, not faked): the verified-catalyst
// requirement, official NSE filings, the intraday relVol/session normalization, sector-breadth
// strength, and institutional bulk-deal data — none of which are stored historically. So this
// tests the momentum/RS/volume/technicals + regime + RR spine; it does NOT prove the catalyst
// gate. A NO-TRADE day (gates not met) is recorded as such, mirroring production's core rule.
function evalQualityMomentumLive(candidates, holdDays, bench, benchCloses, opts = {}) {
  const universeRows = candidates.map(c => {
    const last = c._asOfRow || {};
    const prev = c.closes.length > 1 ? c.closes[c.closes.length - 2] : null;
    return {
      symbol: c.symbol, lastPrice: last.close, dayHigh: last.high, dayLow: last.low,
      pChange: prev > 0 ? ((last.close - prev) / prev) * 100 : null,
    };
  });
  const regime = classifyRegimeV2(benchCloses || [], universeRows, sectorStrength(universeRows));
  const gates = regimeGates(regime.regime);
  const scored = scoreQualityMomentum(
    candidates.map(c => ({ symbol: c.symbol, fullName: c.fullName, closes: c.closes, volumes: c.volumes, sectorScore: 50, catalystPoints: 0 })),
    { benchCloses, regimeScore: regime.score });
  if (!scored.length) return { noTrade: true, reason: 'no candidates', regime: regime.regime };
  const winner = scored[0]; // already ranked by confidence
  const rr = winner.rewardRisk?.rr ?? 0;
  if ((winner.confidence ?? 0) < gates.minConfidence || rr < gates.minRR) {
    return { noTrade: true, reason: `gates: conf ${winner.confidence}<${gates.minConfidence} or rr ${rr}<${gates.minRR}`, regime: regime.regime, pick: winner.symbol, confidence: winner.confidence };
  }
  const src = candidates.find(c => c.symbol === winner.symbol);
  if (!src) return { noTrade: true, reason: 'winner missing forward data', regime: regime.regime };
  const fwd = src._forward.slice(0, holdDays);
  const last = fwd[fwd.length - 1];
  const execution = fwd[0] ? (fwd[0].open ?? fwd[0].close) : null;
  const holdReturn = last && execution ? +(((last.close - execution) / execution) * 100).toFixed(2) : null;
  const sim = execution ? (opts.simFn || simSellEngine)(execution, fwd, src.closes, { ...opts, lane: 'momentum' }) : null;
  const benchRet = benchForwardReturn(bench, src._entryDate, holdDays);
  return {
    noTrade: false, pick: winner.symbol, confidence: winner.confidence, regime: regime.regime,
    rewardRisk: rr, holdReturn, simReturn: sim ? sim.retPct : null,
    benchReturn: benchRet, vsBench: (holdReturn != null && benchRet != null) ? +(holdReturn - benchRet).toFixed(2) : null,
    signalDate: src._entryDate, entryDate: fwd[0]?.date || null, entryPrice: execution,
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
  const slippageBps = Math.max(0, parseInt(req.query.slippage || String(SLIPPAGE_BPS), 10));
  const exitMode = (req.query.exit || 'vol').toLowerCase() === 'fixed' ? 'fixed' : 'vol';
  const simFn = exitMode === 'fixed' ? simSellEngineFixed : simSellEngine;
  const uniChoice = (req.query.universe || 'nifty50').toLowerCase();
  const baseUniverse = uniChoice === 'midcap' ? MIDCAP_SYMBOLS
    : uniChoice === 'all' ? [...NIFTY50_SYMBOLS, ...MIDCAP_SYMBOLS]
    : NIFTY50_SYMBOLS;
  const universeSymbols = [...new Set([...baseUniverse, ...extra].map(aliasBase))];

  const from = (req.query.from || '').slice(0, 10);
  const to = (req.query.to || '').slice(0, 10);
  const rangeMode = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);
  const singleDate = (req.query.date || '').slice(0, 10);

  if (!rangeMode && !/^\d{4}-\d{2}-\d{2}$/.test(singleDate)) {
    return res.status(400).json({ error: 'provide ?date=YYYY-MM-DD OR ?from=YYYY-MM-DD&to=YYYY-MM-DD' });
  }

  // Fetch all series ONCE (2y range covers any backtest date), reused across all days.
  const fetched = await Promise.all(universeSymbols.slice(0, 90).map(async (base) => {
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
    // The live-engine variant tracked separately: it has NO-TRADE days (regime/RR gates), so its
    // denominator differs from the always-picks weight variants above.
    const live = { trades: [], picks: [], noTradeDays: 0 };
    let tradingDays = 0;

    for (const date of dates) {
      const built = buildScoredUniverse(withData, date);
      if (!built) continue; // non-trading day or no eligible candidates
      tradingDays++;
      for (const [name, weights] of Object.entries(VARIANTS)) {
        const ev = evalVariantForDay(built.ranked, weights, holdDays, bench, { slippageBps, simFn });
        if (!ev || ev.holdReturn == null) continue;
        acc[name].trades.push(ev);
        acc[name].picks.push({ date, ...ev });
      }
      // Live quality-momentum + regime scorer (production-synchronized deterministic spine).
      const lv = evalQualityMomentumLive(built.candidates, holdDays, bench, benchClosesAsOf(bench, date), { slippageBps, simFn });
      if (lv.noTrade) { live.noTradeDays++; live.picks.push({ date, ...lv }); }
      else if (lv.holdReturn != null) { live.trades.push(lv); live.picks.push({ date, ...lv }); }
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

    // Live-engine variant summary (production-synchronized): includes NO-TRADE selectivity.
    const lt = live.trades;
    const liveSummary = lt.length ? {
      tradingDaysConsidered: tradingDays,
      trades: lt.length,
      noTradeDays: live.noTradeDays,
      tradeRate: +((lt.length / Math.max(1, tradingDays)) * 100).toFixed(1),
      avgHoldReturn: +(lt.reduce((a, x) => a + (x.holdReturn ?? 0), 0) / lt.length).toFixed(2),
      avgSimReturn: +(lt.reduce((a, x) => a + (x.simReturn ?? 0), 0) / lt.length).toFixed(2),
      winRateSim: +((lt.filter(x => x.simReturn != null && x.simReturn > 0).length / lt.length) * 100).toFixed(1),
      avgVsNifty: +(lt.reduce((a, x) => a + (x.vsBench ?? 0), 0) / lt.length).toFixed(2),
      avgConfidence: +(lt.reduce((a, x) => a + (x.confidence ?? 0), 0) / lt.length).toFixed(1),
    } : { trades: 0, noTradeDays: live.noTradeDays, tradingDaysConsidered: tradingDays };

    // Rank variants by avg sim-engine return (the metric closest to how it'd actually trade).
    const leaderboard = Object.entries(summary)
      .filter(([, s]) => s.trades > 0)
      .sort((a, b) => (b[1].avgSimReturn ?? -999) - (a[1].avgSimReturn ?? -999))
      .map(([name, s], i) => ({ rank: i + 1, variant: name, avgSimReturn: s.avgSimReturn, winRateSim: s.winRateSim, avgVsNifty: s.avgVsNifty }));

    return res.status(200).json({
      mode: 'range_variants',
      engine: 'vol-adaptive-v2',
      from, to, step, holdDays,
      universe: uniChoice, slippageBps, exitMode,
      calendarDays: dates.length,
      tradingDays,
      universeSize: withData.length,
      benchmark: bench ? 'NIFTY50 (^NSEI)' : 'unavailable',
      variantWeights: VARIANTS,
      summary,
      liveEngine: liveSummary,
      leaderboard,
      picksByVariant: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.picks])),
      livePicks: live.picks,
      caveats: [
        `Universe = ${uniChoice} + extras, NOT that day\'s live discovery output.`,
        'All weight variants share point-in-time factor ranks; only composite weights differ.',
        'liveEngine = production scoreQualityMomentum + regime + reward/risk gates (the synchronized spine).',
        'liveEngine does NOT test the verified-catalyst gate, NSE filings, intraday relVol, sector-breadth, or institutional data — none are stored historically, so they are neutralized (catalyst=0, sector=50), NOT faked.',
        'Fundamentals junk-filter uses CURRENT ratios (not point-in-time).',
        `Sim exits model gap-downs (fill at open through the stop) + ${slippageBps}bps slippage; buy-and-hold return does not.`,
        'Entries execute at the next session open because daily history cannot reproduce the live intraday signal-time fill.',
        'Exit simulation matches live stop/trail/momentum/review rules; thesis changes remain neutral because point-in-time filing history is not stored.',
        'Survivorship bias: the universe is names liquid TODAY, so failed/delisted names are absent (results skew optimistic).',
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
  const fwd = pickRow._forward.slice(0, holdDays);
  const entry = fwd[0] ? (fwd[0].open ?? fwd[0].close) : null;
  const perf = entry ? fwd.map(r => ({ date: r.date, close: r.close, retPct: +(((r.close - entry) / entry) * 100).toFixed(2) })) : [];
  const exitRow = fwd[fwd.length - 1];
  const holdReturn = exitRow && entry ? +(((exitRow.close - entry) / entry) * 100).toFixed(2) : null;
  const bestDay = perf.reduce((m, p) => p.retPct > (m?.retPct ?? -999) ? p : m, null);
  const worstDay = perf.reduce((m, p) => p.retPct < (m?.retPct ?? 999) ? p : m, null);
  const simExit = entry ? simFn(entry, fwd, pickRow.closes, { slippageBps }) : null;
  const benchRet = benchForwardReturn(bench, pickRow._entryDate, holdDays);

  // Production-synchronized live-engine pick for the same day (regime + confidence + RR gates).
  const livePick = evalQualityMomentumLive(built.candidates, holdDays, bench, benchClosesAsOf(bench, date), { slippageBps, simFn });

  const leaderboard = ranked.slice(0, 5).map(r => {
    const ex = r._row._forward.slice(0, holdDays);
    const last = ex[ex.length - 1];
    const exEntry = ex[0] ? (ex[0].open ?? ex[0].close) : null;
    return {
      symbol: r.symbol, composite: r.composite, verdict: r.verdict,
      momentum: r.factors.momentum, volumeRatio: r.volumeRatio,
      forwardReturn: last && exEntry ? +(((last.close - exEntry) / exEntry) * 100).toFixed(2) : null,
    };
  });

  return res.status(200).json({
    mode: 'single_date',
    date, holdDays,
    universe: uniChoice, slippageBps,
    universeSize: built.candidates.length,
    benchmark: bench ? 'NIFTY50 (^NSEI)' : 'unavailable',
    rejectedJunk: rejected.map(r => ({ symbol: r.symbol, reasons: r.junkReasons })),
    pick: {
      symbol: pick.symbol, composite: pick.composite, verdict: pick.verdict,
      momentum: pick.factors.momentum, volume: pick.factors.volume,
      volumeRatio: pick.volumeRatio, annualizedVol: pick.annualizedVol,
      signalDate: pickRow._entryDate, entryDate: fwd[0]?.date || null, entryPrice: entry,
    },
    performance: { holdReturn, vsNifty: (holdReturn != null && benchRet != null) ? +(holdReturn - benchRet).toFixed(2) : null, niftyReturn: benchRet, bestDay, worstDay, dayByDay: perf },
    simulatedSellEngine: simExit,
    liveEnginePick: livePick,
    leaderboard,
    caveats: [
      'Candidate pool = configured universe + extras, NOT that day\'s live discovery output.',
      'Momentum/volume are point-in-time accurate; fundamentals junk-filter uses current ratios.',
      'Execution is the next session open because intraday signal-time bars are unavailable.',
      'liveEnginePick = production scoreQualityMomentum + regime + RR gates; catalyst/sector/institutional are neutralized (not stored historically), so it tests the deterministic spine only.',
      'Approximation for learning, not a broker-grade backtest. Past results != future results.',
    ],
  });
}
