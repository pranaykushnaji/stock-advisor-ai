// api/_scoring.js
import { computeIndicators, ema } from './_indicators.js';
// Deterministic factor scoring. The LLM no longer supplies fundamentals numbers;
// it only scores what real data can't provide, and writes qualitative summaries.
//
// Three improvements implemented here:
//  (1) Quality & Value computed from REAL fundamentals (source-tagged), not LLM-recalled.
//  (2) Momentum is VOLATILITY-SCALED — raw momentum / recent realized vol — to cut crash risk
//      (Barroso–Santa-Clara / Daniel–Moskowitz: scaling by vol roughly halves max drawdown).
//  (3) Cross-sectional, sector-neutral RANKING — each stock scored by its percentile within the
//      candidate universe (and within sector where possible), not against fixed absolute cutoffs.

// ---------- price-derived factors (unchanged data source: your OHLCV chart) ----------

// Trailing returns over ~3/6/12 months from a close-price series (most recent last).
export function computeReturns(closes) {
  if (!Array.isArray(closes) || closes.length < 30) return null;
  const last = closes[closes.length - 1];
  const at = (tradingDaysAgo) => {
    const i = closes.length - 1 - tradingDaysAgo;
    return i >= 0 ? closes[i] : null;
  };
  const r = (past) => (past ? (last - past) / past : null);
  return {
    r3: r(at(63)),   // ~3 months
    r6: r(at(126)),  // ~6 months
    r12: r(at(252)), // ~12 months
  };
}

// SHORT-TERM returns for the momentum-trading (bouquet) mode: 1-day, 1-week, 1-month.
// Tolerant of short series — returns whatever windows the data supports.
export function computeShortReturns(closes) {
  if (!Array.isArray(closes) || closes.length < 6) return null;
  const last = closes[closes.length - 1];
  const at = (n) => { const i = closes.length - 1 - n; return i >= 0 ? closes[i] : null; };
  const r = (past) => (past && past > 0 ? (last - past) / past : null);
  return {
    r1d: r(at(1)),   // 1 day
    r1w: r(at(5)),   // 1 week (~5 trading days)
    r1m: r(at(21)),  // 1 month (~21 trading days)
  };
}

// Short-term momentum blend, weighted toward the 1-week/1-month windows (the
// swing-trade horizon). Vol-scaled downstream like the long-term momentum.
export function shortMomentum(shortReturns) {
  if (!shortReturns) return null;
  const parts = [
    { v: shortReturns.r1m, w: 0.45 },
    { v: shortReturns.r1w, w: 0.40 },
    { v: shortReturns.r1d, w: 0.15 },
  ].filter(p => p.v != null && isFinite(p.v));
  if (!parts.length) return null;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  return parts.reduce((a, p) => a + p.v * p.w, 0) / wsum;
}

// Liquidity/volume signal: recent avg volume vs longer-run avg (volume surge = higher).
// Guards against illiquid junk: returns { ratio, avgRecent } — ratio ~1 is normal,
// >1.3 is a volume surge, and very low avgRecent flags an illiquid (junk) name.
export function volumeSignal(volumes) {
  if (!Array.isArray(volumes)) return null;
  const v = volumes.filter(x => x != null && isFinite(x) && x >= 0);
  if (v.length < 10) return null;
  const recent = v.slice(-5);
  const baseline = v.slice(-30);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const avgRecent = avg(recent);
  const avgBase = avg(baseline) || 1;
  return { ratio: +(avgRecent / avgBase).toFixed(2), avgRecent: Math.round(avgRecent) };
}

// Annualized realized volatility from daily closes (std dev of daily log returns * sqrt(252)).
export function annualizedVol(closes) {
  if (!Array.isArray(closes) || closes.length < 20) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 15) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

// Raw momentum blend (weighted toward 6/12m, the academically robust windows), tolerant of
// partial history: renormalizes over whatever windows are available rather than requiring all.
export function rawMomentum(returns) {
  if (!returns) return null;
  const parts = [
    { v: returns.r12, w: 0.5 },
    { v: returns.r6, w: 0.3 },
    { v: returns.r3, w: 0.2 },
  ].filter(p => p.v != null && isFinite(p.v));
  if (!parts.length) return null;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  return parts.reduce((a, p) => a + p.v * p.w, 0) / wsum;
}

// (2) Volatility-scaled momentum signal: raw momentum divided by recent realized vol.
// Floored vol avoids divide-by-tiny blowups. This is the raw signal; it gets ranked below.
export function volScaledMomentum(rawMom, vol) {
  if (rawMom == null) return null;
  const v = (vol != null && vol > 0) ? Math.max(vol, 0.08) : 0.30; // floor 8% ann., default 30%
  return rawMom / v;
}

// ---------- fundamentals-derived factor inputs (real, source-tagged) ----------

// Convert a raw fundamentals record into signed factor *inputs* (higher = better on that factor).
// These are RAW values, later ranked cross-sectionally. Null stays null (ranking skips nulls).
export function qualityInputs(f) {
  // Quality: high ROE/ROCE/margins/growth, LOW debt. Invert debt so higher=better.
  return {
    roe: f.roe,
    roce: f.roce,
    lowDebt: f.debtToEquity != null ? -f.debtToEquity : null,
    netMargin: f.netMargin,
    earningsGrowth: f.earningsGrowth,
  };
}
export function valueInputs(f) {
  // Value: CHEAP = better, so invert PE/PB/PEG (lower ratio -> higher score). Yield: higher=better.
  return {
    cheapPE: f.peRatio != null && f.peRatio > 0 ? -f.peRatio : null,
    cheapPB: f.pbRatio != null && f.pbRatio > 0 ? -f.pbRatio : null,
    cheapPEG: f.pegRatio != null && f.pegRatio > 0 ? -f.pegRatio : null,
    dividendYield: f.dividendYield,
  };
}

// ---------- (3) cross-sectional ranking ----------

// Percentile-rank a value within an array of peers (nulls excluded). Returns 0..100.
// If only one non-null peer, returns 50 (no dispersion to rank against).
export function percentileRank(value, peers) {
  if (value == null) return null;
  const valid = peers.filter(v => v != null && isFinite(v));
  if (valid.length < 2) return 50;
  const below = valid.filter(v => v < value).length;
  const equal = valid.filter(v => v === value).length;
  return +(((below + 0.5 * equal) / valid.length) * 100).toFixed(1);
}

// Rank a set of stocks on a single metric cross-sectionally. `getVal(stock)` extracts the raw value.
// Returns a Map(stock -> percentile). Sector-neutral if `sectorOf` provided (ranks within sector,
// falling back to whole-universe when a sector has <3 members).
export function rankMetric(stocks, getVal, sectorOf = null) {
  const out = new Map();
  const allVals = stocks.map(getVal);
  for (const s of stocks) {
    let peers = allVals;
    if (sectorOf) {
      const sec = sectorOf(s);
      const sectorStocks = stocks.filter(x => sectorOf(x) === sec);
      if (sectorStocks.length >= 3) peers = sectorStocks.map(getVal);
    }
    out.set(s, percentileRank(getVal(s), peers));
  }
  return out;
}

// Average a list of percentile scores, ignoring nulls. Returns null if all null.
export function meanScore(scores) {
  const valid = scores.filter(v => v != null && isFinite(v));
  if (!valid.length) return null;
  return +(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1);
}

// A stock is POTD-eligible only if it has REAL fundamentals (not 'estimated') AND
// both fundamental factors could be computed. Price-only stocks are analyzable but
// never auto-picked, keeping the daily pick grounded in real data.
export function isPotdEligible(scoredStock) {
  return scoredStock.fundamentalsSource !== 'estimated'
    && scoredStock.factors.quality != null
    && scoredStock.factors.value != null;
}

// ---------- composite ----------

// Weights match the existing model. Re-normalized over available factors so a missing
// factor (e.g. no fundamentals) doesn't zero out the composite — it reweights the rest.
export const FACTOR_WEIGHTS = { momentum: 0.30, quality: 0.28, value: 0.22, lowVol: 0.20 };

export function composite(scores) {
  const parts = [];
  for (const [k, w] of Object.entries(FACTOR_WEIGHTS)) {
    if (scores[k] != null && isFinite(scores[k])) parts.push({ v: scores[k], w });
  }
  if (!parts.length) return null;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  return +(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum).toFixed(1);
}

export function verdict(comp) {
  if (comp == null) return 'UNKNOWN';
  if (comp >= 70) return 'BUY';
  if (comp >= 50) return 'HOLD';
  return 'AVOID';
}

// ---------- MOMENTUM-DOMINANT scoring (bouquet / swing-trade mode) ----------
// Aggressive, short-horizon: momentum leads, quality is only a junk-filter, volume
// confirms interest, technicals confirm trend, low-vol lightly penalizes wild names.
// SEPARATE from scoreUniverse (long-term model used by Advisor).
//
// WEIGHTS — momentum + volume only. Backtest evidence (61 trades, Mar–Jun 2026, hold=5):
// this pairing returned +0.56%/trade at a 60.7% win rate and beat the Nifty 57% of the time,
// while the old 5-factor blend was a coin flip (~-0.01%, ~50%) and the technicals factor
// actively hurt (-1.09%). The other factors (technicals, quality, lowVol) are still COMPUTED
// — shown in the UI/narrative and used by the junk filter — they just no longer drive the
// composite. Revisit once the midcap backtest (see api/backtest.js ?universe=midcap) lands.
export const MOMENTUM_WEIGHTS = { momentum: 0.70, volume: 0.30 };

// Junk filter: reject names too illiquid or too wild to trade — the
// "don't buy a manipulated microcap" guard. Tunable.
export const JUNK_FILTER = { MIN_AVG_VOLUME: 50000, MAX_ANNUAL_VOL: 0.70, MIN_PRICE: 20 };

function momentumComposite(scores) {
  const parts = [];
  for (const [k, w] of Object.entries(MOMENTUM_WEIGHTS)) {
    if (scores[k] != null && isFinite(scores[k])) parts.push({ v: scores[k], w });
  }
  if (!parts.length) return null;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  return +(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum).toFixed(1);
}

export function scoreMomentumUniverse(candidates, opts = {}) {
  const benchCloses = opts.benchCloses || null; // Nifty closes for relative strength
  const enriched = candidates.map(c => {
    const shortRet = computeShortReturns(c.closes);
    const shortMom = shortMomentum(shortRet);
    const vol = annualizedVol(c.closes);
    const volSig = volumeSignal(c.volumes);
    const lastPrice = Array.isArray(c.closes) && c.closes.length ? c.closes[c.closes.length - 1] : (c.price ?? null);
    const indicators = computeIndicators(c.closes || [], { highs: c.highs, lows: c.lows, benchCloses });
    const reasons = [];
    if (volSig && volSig.avgRecent < JUNK_FILTER.MIN_AVG_VOLUME) reasons.push('illiquid');
    if (vol != null && vol > JUNK_FILTER.MAX_ANNUAL_VOL) reasons.push('too-volatile');
    if (lastPrice != null && lastPrice < JUNK_FILTER.MIN_PRICE) reasons.push('penny-stock');
    return { ...c, _shortRet: shortRet, _shortMom: shortMom, _vol: vol, _volSig: volSig, _lastPrice: lastPrice, _ind: indicators, _junkReasons: reasons };
  });

  const momRank = rankMetric(enriched, s => volScaledMomentum(s._shortMom, s._vol));
  const volumeRank = rankMetric(enriched, s => s._volSig ? s._volSig.ratio : null);
  const lowVolRank = rankMetric(enriched, s => s._vol != null ? -s._vol : null);
  const techRank = rankMetric(enriched, s => s._ind?.techScore ?? null);
  const qRank = rankMetric(enriched, s => {
    const f = s.fundamentals?.fields || {};
    const bits = [f.roe, f.debtToEquity != null ? -f.debtToEquity : null, f.netMargin].filter(v => v != null);
    return bits.length ? bits.reduce((a, b) => a + b, 0) / bits.length : null;
  });

  const scored = enriched.map(s => {
    const scores = {
      momentum: momRank.get(s),
      technicals: techRank.get(s) ?? 50,
      quality: qRank.get(s) ?? 50,
      volume: volumeRank.get(s),
      lowVol: lowVolRank.get(s),
    };
    const comp = momentumComposite(scores);
    return {
      symbol: s.symbol, fullName: s.fullName, sector: s.fundamentals?.fields?.sector || s.sector || 'UNKNOWN',
      factors: scores, shortReturns: s._shortRet,
      indicators: s._ind ? { rsi: s._ind.rsi, macdHist: s._ind.macd?.histogram ?? null, maAlignment: s._ind.maAlignment, relativeStrength: s._ind.relativeStrength, techScore: s._ind.techScore } : null,
      annualizedVol: s._vol != null ? +(s._vol * 100).toFixed(1) : null,
      volumeRatio: s._volSig ? s._volSig.ratio : null,
      composite: comp,
      verdict: comp == null ? 'UNKNOWN' : comp >= 65 ? 'BUY' : comp >= 45 ? 'WATCH' : 'AVOID',
      junkReasons: s._junkReasons,
      tradeable: s._junkReasons.length === 0,
    };
  });

  const clean = scored.filter(s => s.tradeable);
  clean.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
  return { ranked: clean, rejected: scored.filter(s => !s.tradeable) };
}

// ---------- QUALITY-MOMENTUM entry filter + scoring (the discovery-quality rework) ----------
// Only trade high-quality momentum, not every top gainer. A candidate must pass ALL of:
//   price > 20 EMA, 20 EMA > 50 EMA, today's vol > 1.8× 20-day avg, today's gain > Nifty gain,
//   price within 8% of the 52-week high, and daily traded value > ₹75 Cr.
// Plus hard-reject red flags (gap-up >8%, circuit-locked, ASM/GSM surveillance, illiquid).
// ctx: { niftyGainPct, tradedValueCr, pChange, open, prevClose, dayHigh, dayLow, surveillance }.
export function qualityMomentumChecks(closes, volumes, ctx = {}) {
  const price = Array.isArray(closes) && closes.length ? closes[closes.length - 1] : (ctx.price ?? null);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50), ema200 = ema(closes, 200);
  const hi52 = Array.isArray(closes) && closes.length ? Math.max(...closes.slice(-252)) : null;
  const vols = (volumes || []).filter(v => v != null && isFinite(v));
  const todayVol = ctx.todayVolume ?? (vols.length ? vols[vols.length - 1] : null);
  const avg20Vol = vols.length >= 21 ? vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20
    : (vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null);
  const relVol = (todayVol != null && avg20Vol) ? todayVol / avg20Vol : null;

  const checks = {
    priceAboveEma20: (price != null && ema20 != null) ? price > ema20 : null,
    ema20AboveEma50: (ema20 != null && ema50 != null) ? ema20 > ema50 : null,
    volumeSurge: relVol != null ? relVol >= 1.8 : null,
    beatsNifty: (ctx.pChange != null && ctx.niftyGainPct != null) ? ctx.pChange > ctx.niftyGainPct : null,
    near52wHigh: (price != null && hi52) ? price >= 0.92 * hi52 : null,
    liquidValue: ctx.tradedValueCr != null ? ctx.tradedValueCr > 75 : null,
  };
  const failed = Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k);
  const undetermined = Object.entries(checks).filter(([, v]) => v == null).map(([k]) => k);
  const pass = failed.length === 0 && undetermined.length <= 1; // tolerate 1 missing input

  const rejects = [];
  const gapUp = (ctx.open != null && ctx.prevClose) ? (ctx.open - ctx.prevClose) / ctx.prevClose * 100 : null;
  if (gapUp != null && gapUp > 8) rejects.push(`gap-up ${gapUp.toFixed(1)}%`);
  if (ctx.surveillance) rejects.push('surveillance (ASM/GSM)');
  if (ctx.tradedValueCr != null && ctx.tradedValueCr < 75) rejects.push(`illiquid (₹${ctx.tradedValueCr.toFixed(0)}Cr)`);
  if (ctx.dayHigh != null && ctx.dayLow != null && ctx.pChange != null) {
    if (ctx.dayHigh === ctx.dayLow) rejects.push('circuit-locked');
    else if (price != null && price >= ctx.dayHigh * 0.999 && ctx.pChange >= 5) rejects.push('near upper circuit');
    else if (price != null && price <= ctx.dayLow * 1.001 && ctx.pChange <= -5) rejects.push('near lower circuit');
  }
  // 200-EMA trend + room-to-52w-high are SOFT signals (directive: "above 200 EMA where
  // practical", "avoid late-stage") — surfaced for scoring/confidence, not hard-filtered.
  const aboveEma200 = (price != null && ema200 != null) ? price > ema200 : null;
  const roomTo52wHighPct = (price != null && hi52) ? +((hi52 - price) / price * 100).toFixed(1) : null;
  return { pass, checks, failed, undetermined, relVol: relVol != null ? +relVol.toFixed(2) : null, hi52, aboveEma200, roomTo52wHighPct, rejects };
}

// Multi-signal CONFIDENCE = agreement between independent signals (directive: "no single
// factor decides"). High when many signals are strong and few are weak; a supportive market
// regime lifts it, a weak one drags it.
export function agreementConfidence(signals, regimeScore = null) {
  const vals = Object.values(signals).filter(v => v != null && isFinite(v));
  if (!vals.length) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const strong = vals.filter(v => v >= 60).length;
  const weak = vals.filter(v => v < 40).length;
  let conf = mean * 0.55 + (strong / vals.length) * 100 * 0.45 - weak * 6;
  if (regimeScore != null) conf = conf * 0.85 + regimeScore * 0.15;
  return Math.max(0, Math.min(100, +conf.toFixed(1)));
}

// Deterministic reward/risk estimate for a momentum swing. Downside = a vol-based stop;
// upside = a continuation estimate (part of last month's move) plus room to the prior high,
// floored above the stop. Transparent, not a black box.
export function rewardRisk(closes, shortRet, roomTo52wHighPct) {
  const c = (closes || []).filter(v => v != null && isFinite(v));
  let dv = 2.2;
  if (c.length >= 15) {
    const r = []; for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1]));
    const m = r.reduce((a, b) => a + b, 0) / (r.length || 1);
    const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, r.length - 1);
    dv = Math.sqrt(v) * 100 || 2.2;
  }
  const downsidePct = Math.max(4, Math.min(12, 2.5 * dv));
  const r1m = shortRet?.r1m != null ? shortRet.r1m * 100 : 0;
  const upsidePct = Math.max(4, Math.min(25, Math.max(0, r1m) * 0.4 + Math.max(0, roomTo52wHighPct || 0) + downsidePct));
  return { rr: +(upsidePct / downsidePct).toFixed(2), upsidePct: +upsidePct.toFixed(1), downsidePct: +downsidePct.toFixed(1) };
}

// Generic weighted composite over present factors (renormalized over what's available).
export function weightedComposite(scores, weights) {
  const parts = [];
  for (const [k, w] of Object.entries(weights)) if (scores[k] != null && isFinite(scores[k])) parts.push({ v: scores[k], w });
  if (!parts.length) return null;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  return +(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum).toFixed(1);
}

// Final ranking for the quality-momentum strategy. NO fundamentals — for 5-10 day trades,
// price/volume/relative-strength/catalyst matter, not valuation. No single factor decides;
// candidates are ordered by multi-signal CONFIDENCE (agreement), then composite.
// Weights: momentum 30 / relative-strength 20 / catalyst 20 / volume 15 / technicals 10 / sector 5.
// Callers attach catalystPoints (0-40) and sectorScore (0-100); opts carries benchCloses
// (Nifty, for relative strength) and regimeScore (market supportiveness).
export const QUALITY_MOMENTUM_WEIGHTS = { momentum: 0.30, relStrength: 0.20, catalyst: 0.20, volume: 0.15, technicals: 0.10, sector: 0.05 };
export function scoreQualityMomentum(candidates, opts = {}) {
  const benchCloses = opts.benchCloses || null;
  const regimeScore = opts.regimeScore ?? null;
  const enriched = candidates.map(c => {
    const shortRet = computeShortReturns(c.closes);
    return { ...c, _shortRet: shortRet, _shortMom: shortMomentum(shortRet), _vol: annualizedVol(c.closes),
      _volSig: volumeSignal(c.volumes), _ind: computeIndicators(c.closes || [], { benchCloses }) };
  });
  const momRank = rankMetric(enriched, s => volScaledMomentum(s._shortMom, s._vol));
  const volRank = rankMetric(enriched, s => s._volSig ? s._volSig.ratio : null);
  const rsRank = rankMetric(enriched, s => s._ind?.relativeStrength ?? null);
  const scored = enriched.map(s => {
    const scores = {
      momentum: momRank.get(s),
      relStrength: rsRank.get(s),
      catalyst: Math.max(0, Math.min(100, (s.catalystPoints || 0) / 40 * 100)),
      volume: volRank.get(s),
      technicals: s._ind?.techScore ?? 50,
      sector: (s.sectorScore != null && isFinite(s.sectorScore)) ? s.sectorScore : 50,
    };
    const comp = weightedComposite(scores, QUALITY_MOMENTUM_WEIGHTS);
    const confidence = agreementConfidence(scores, regimeScore);
    const hi52 = (s.closes && s.closes.length) ? Math.max(...s.closes.slice(-252)) : null;
    const room = (hi52 && s.closes.length) ? (hi52 - s.closes[s.closes.length - 1]) / s.closes[s.closes.length - 1] * 100 : null;
    const rr = rewardRisk(s.closes, s._shortRet, room);
    return {
      symbol: s.symbol, fullName: s.fullName, sector: s.sector || 'UNKNOWN',
      factors: scores, shortReturns: s._shortRet,
      volumeRatio: s._volSig ? s._volSig.ratio : null,
      relStrength: s._ind?.relativeStrength ?? null,
      annualizedVol: s._vol != null ? +(s._vol * 100).toFixed(1) : null,
      catalystPoints: s.catalystPoints || 0, catalyst: s.catalyst || null,
      indicators: s._ind ? { rsi: s._ind.rsi, techScore: s._ind.techScore, relativeStrength: s._ind.relativeStrength, maAlignment: s._ind.maAlignment } : null,
      composite: comp, confidence, rewardRisk: rr,
      verdict: comp == null ? 'UNKNOWN' : comp >= 65 ? 'BUY' : comp >= 45 ? 'WATCH' : 'AVOID',
    };
  });
  // Directive: agreement between independent signals leads, not one strong factor.
  scored.sort((a, b) => (b.confidence - a.confidence) || ((b.composite ?? -1) - (a.composite ?? -1)));
  return scored;
}

// ---------- orchestration: score a whole candidate universe cross-sectionally ----------
// Each candidate: { symbol, fullName, closes:[], fundamentals:{source,fields}, sector }
// opts.potdOnly: if true, drops stocks without real fundamentals from the final ranking
// (used by the daily-pick cron). Advisor/on-demand callers omit it to keep everything.
// Returns candidates enriched with per-factor scores + composite + verdict, ranked.
export function scoreUniverse(candidates, opts = {}) {
  // 1. Precompute per-stock price factors + raw fundamental inputs
  const enriched = candidates.map(c => {
    const returns = computeReturns(c.closes);
    const vol = annualizedVol(c.closes);
    const rawMom = rawMomentum(returns);
    return {
      ...c,
      _vol: vol,
      _volMom: volScaledMomentum(rawMom, vol),
      _lowVolRaw: vol != null ? -vol : null, // lower vol = better
      _q: qualityInputs(c.fundamentals.fields),
      _v: valueInputs(c.fundamentals.fields),
      _fundSource: c.fundamentals.source,
    };
  });

  const sectorOf = (s) => (s.fundamentals?.fields?.sector || s.sector || 'UNKNOWN');

  // 2. Cross-sectional ranks (momentum & low-vol whole-universe; quality/value sector-neutral)
  const momRank = rankMetric(enriched, s => s._volMom);
  const lowVolRank = rankMetric(enriched, s => s._lowVolRaw);

  const qMetrics = ['roe', 'roce', 'lowDebt', 'netMargin', 'earningsGrowth'];
  const vMetrics = ['cheapPE', 'cheapPB', 'cheapPEG', 'dividendYield'];
  const qRanks = Object.fromEntries(qMetrics.map(m => [m, rankMetric(enriched, s => s._q[m], sectorOf)]));
  const vRanks = Object.fromEntries(vMetrics.map(m => [m, rankMetric(enriched, s => s._v[m], sectorOf)]));

  // 3. Assemble factor scores + composite
  const scored = enriched.map(s => {
    const momentum = momRank.get(s);
    const lowVol = lowVolRank.get(s);
    const quality = meanScore(qMetrics.map(m => qRanks[m].get(s)));
    const value = meanScore(vMetrics.map(m => vRanks[m].get(s)));
    const scores = { momentum, quality, value, lowVol };
    const comp = composite(scores);
    const result = {
      symbol: s.symbol, fullName: s.fullName, sector: sectorOf(s),
      factors: scores,
      fundamentalsSource: s._fundSource,
      annualizedVol: s._vol != null ? +(s._vol * 100).toFixed(1) : null,
      composite: comp,
      verdict: verdict(comp),
    };
    result.potdEligible = isPotdEligible(result);
    return result;
  });

  // 4. Optionally drop POTD-ineligible (no real fundamentals) stocks
  const finalList = opts.potdOnly ? scored.filter(s => s.potdEligible) : scored;

  // 5. Rank by composite, best first
  finalList.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
  return finalList;
}
