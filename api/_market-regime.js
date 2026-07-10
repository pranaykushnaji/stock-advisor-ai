// api/_market-regime.js
// Deterministic market-regime classifier from the benchmark (Nifty) close series.
// Drives ADAPTIVE selectivity: in weak/volatile regimes the engine raises its bar, demands
// verified catalysts and better reward/risk, and returns NO TRADE more readily. Pure — no I/O.
import { ema } from './_indicators.js';

// Classify the market into bullish / neutral / weak / volatile, with a 0-100 supportiveness
// score used as an input to the multi-signal confidence.
export function classifyRegime(niftyCloses) {
  const closes = (niftyCloses || []).filter(v => v != null && isFinite(v));
  if (closes.length < 60) return { regime: 'unknown', score: 50, reason: 'insufficient index history' };
  const price = closes[closes.length - 1];
  const e50 = ema(closes, 50);
  const e200 = closes.length >= 200 ? ema(closes, 200) : null;
  const r = (n) => closes.length > n + 1 ? (price - closes[closes.length - 1 - n]) / closes[closes.length - 1 - n] * 100 : 0;
  const r20 = r(20), r50 = r(50);

  // Annualized realized vol of the index over the last ~30 sessions.
  const rets = [];
  for (let i = Math.max(1, closes.length - 30); i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const annVol = Math.sqrt(variance) * Math.sqrt(252) * 100;

  const aboveE50 = e50 != null && price > e50;
  const aboveE200 = e200 == null ? aboveE50 : price > e200;
  const stacked = (e50 != null && e200 != null) ? e50 > e200 : aboveE50;
  const highVol = annVol > 22;

  let regime, score;
  if (aboveE50 && aboveE200 && stacked && r20 > -1) { regime = 'bullish'; score = 78; }
  else if (!aboveE50 || r20 < -3 || (!stacked && r50 < 0)) { regime = 'weak'; score = 32; }
  else { regime = 'neutral'; score = 55; }
  if (highVol && regime !== 'weak') { regime = 'volatile'; score = Math.min(score, 42); }

  return {
    regime, score,
    annVol: +annVol.toFixed(1), r20: +r20.toFixed(1), r50: +r50.toFixed(1),
    aboveE50, aboveE200,
    reason: `${regime} — Nifty ${r20 >= 0 ? '+' : ''}${r20.toFixed(1)}% 20d, ${aboveE50 ? 'above' : 'below'} 50EMA, vol ${annVol.toFixed(0)}%`,
  };
}

// ---- V2 FACTOR-BASED REGIME (computed once per scan, reused everywhere) ----
// Eight independently-scored factors instead of three EMA checks. Each factor is 0-100
// (higher = more supportive of buying momentum); the overall regime label maps from the
// weighted blend, and regime CONFIDENCE measures how much the factors agree — a market where
// half the factors scream bull and half scream bear gets a low-confidence label, which is
// itself information (the gates stay at the blended label either way; confidence is surfaced
// for the narrative/analytics).
//
// Factors and their data sources (all already fetched per scan — zero new requests):
//   indexTrend      — Nifty EMA structure + 20/50d returns        (Nifty 1y closes)
//   volatility      — Nifty 30d realized vol, inverted            (Nifty 1y closes)
//   breadth         — % of the snapshot universe up today         (snapshot universe)
//   momentumBreadth — % of the universe up >1% today              (snapshot universe)
//   largeCap        — NIFTY-50 members' avg move vs whole universe (snapshot `index` field)
//   sectorPart      — share of sectors with positive average move (sectorStrength map)
//   gapEnv          — universe closing-strength: are stocks holding their intraday gains
//                     (close near day-high = healthy) or fading (near day-low = trap-ish)
//   riskAppetite    — advancer strength: avg gain of gainers vs avg loss of decliners
export function classifyRegimeV2(niftyCloses, universeRows = [], sectorMap = null) {
  const v1 = classifyRegime(niftyCloses); // reuse the proven index-trend math
  const rows = (universeRows || []).filter(r => typeof r.pChange === 'number');
  const f = {};

  // Index factors from v1's computation.
  f.indexTrend = v1.regime === 'unknown' ? 50
    : Math.round(Math.max(0, Math.min(100, 50 + (v1.aboveE50 ? 15 : -15) + (v1.aboveE200 ? 10 : -10) + v1.r20 * 3)));
  f.volatility = v1.annVol == null ? 50 : Math.round(Math.max(0, Math.min(100, 115 - v1.annVol * 3))); // vol 12%→79, 22%→49, 30%→25

  if (rows.length >= 50) {
    const up = rows.filter(r => r.pChange > 0).length / rows.length;
    f.breadth = Math.round(up * 100);
    f.momentumBreadth = Math.round((rows.filter(r => r.pChange > 1).length / rows.length) * 100 * 2.2); // 45%+ strong-movers ≈ 100
    f.momentumBreadth = Math.min(100, f.momentumBreadth);
    const nifty50 = rows.filter(r => r.index === 'NIFTY 50');
    if (nifty50.length >= 20) {
      const avgAll = rows.reduce((a, r) => a + r.pChange, 0) / rows.length;
      const avgLarge = nifty50.reduce((a, r) => a + r.pChange, 0) / nifty50.length;
      f.largeCap = Math.round(Math.max(0, Math.min(100, 50 + (avgLarge - avgAll) * 25 + avgLarge * 10)));
    } else f.largeCap = 50;
    // Gap environment / intraday conviction: where are closes sitting in the day range?
    const strengths = rows.filter(r => r.dayHigh > r.dayLow && r.lastPrice != null)
      .map(r => (r.lastPrice - r.dayLow) / (r.dayHigh - r.dayLow));
    f.gapEnv = strengths.length >= 50 ? Math.round((strengths.reduce((a, b) => a + b, 0) / strengths.length) * 100) : 50;
    // Risk appetite: are gainers gaining more than losers are losing?
    const gains = rows.filter(r => r.pChange > 0).map(r => r.pChange);
    const losses = rows.filter(r => r.pChange < 0).map(r => -r.pChange);
    const avgG = gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;
    const avgL = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0.01;
    f.riskAppetite = Math.round(Math.max(0, Math.min(100, 50 + (avgG - avgL) * 22)));
  } else { f.breadth = 50; f.momentumBreadth = 50; f.largeCap = 50; f.gapEnv = 50; f.riskAppetite = 50; }

  if (sectorMap && sectorMap.size >= 4) {
    const secs = [...sectorMap.values()];
    f.sectorPart = Math.round((secs.filter(s => s.avgPChange > 0).length / secs.length) * 100);
  } else f.sectorPart = 50;

  // Weighted blend → overall score; index trend and vol carry the most, breadth family next.
  const W = { indexTrend: 0.24, volatility: 0.16, breadth: 0.14, momentumBreadth: 0.12, largeCap: 0.08, sectorPart: 0.08, gapEnv: 0.09, riskAppetite: 0.09 };
  let score = 0; for (const [k, w] of Object.entries(W)) score += f[k] * w;
  score = Math.round(score);

  // Label mapping keeps the four established labels so regimeGates stays valid.
  let regime;
  if (v1.annVol != null && v1.annVol > 22 && score < 62) regime = 'volatile';
  else if (score >= 62) regime = 'bullish';
  else if (score >= 47) regime = 'neutral';
  else regime = 'weak';

  // Regime confidence = factor agreement (low dispersion around the blend = high confidence).
  const vals = Object.values(f);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const disp = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  const regimeConfidence = Math.round(Math.max(0, Math.min(100, 100 - disp * 2.2)));

  return {
    regime, score, regimeConfidence, factors: f,
    annVol: v1.annVol, r20: v1.r20, r50: v1.r50, aboveE50: v1.aboveE50, aboveE200: v1.aboveE200,
    reason: `${regime} (v2 score ${score}, conf ${regimeConfidence}) — trend ${f.indexTrend}, breadth ${f.breadth}, vol-factor ${f.volatility}`,
  };
}

// Regime-adaptive gates. The weaker/wilder the market, the higher the bar and the more we
// insist on a verified catalyst and asymmetric reward/risk.
export function regimeGates(regime) {
  switch (regime) {
    case 'bullish':  return { minConfidence: 55, minRR: 1.5, requireVerified: false };
    case 'neutral':  return { minConfidence: 62, minRR: 1.8, requireVerified: false };
    case 'weak':     return { minConfidence: 72, minRR: 2.2, requireVerified: true };
    case 'volatile': return { minConfidence: 75, minRR: 2.5, requireVerified: true };
    default:         return { minConfidence: 65, minRR: 1.8, requireVerified: false };
  }
}
