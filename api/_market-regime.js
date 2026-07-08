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
