// api/_edge.js
// V2 EXPECTED EDGE — every candidate gets an explicit expectancy estimate:
//   edge% = P(win) × expectedGain − (1 − P(win)) × expectedLoss
// Deterministic and transparent: gain/loss come from the existing reward/risk model (upside
// continuation + room-to-high vs the vol-based stop), and the win probability is a calibrated
// blend of confidence, regime, catalyst strength, volatility — anchored to the measured win
// rate of similar past trades (same lane) once enough of them exist. Used for ranking
// tie-breaks, a positive-expectancy gate, position-size adjustment, and analytics. Stored on
// every trade AND every rejected candidate so calibration itself becomes measurable.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Win-probability model. Base 50% shifted by evidence; clamped to a humble [0.30, 0.75] band —
// nothing in swing trading justifies claiming certainty outside that range.
export function winProbability({ confidence = 50, regime = 'neutral', catalystPoints = 0, annualizedVolPct = null, laneWinRate = null, laneSamples = 0 } = {}) {
  let p = 0.32 + (confidence / 100) * 0.42;                     // conf 50 → 0.53, conf 75 → 0.635
  p += { bullish: 0.05, neutral: 0.0, weak: -0.06, volatile: -0.08 }[regime] ?? 0;
  p += clamp(catalystPoints / 40, 0, 1) * 0.06;                 // a strong verified catalyst helps
  if (annualizedVolPct != null && annualizedVolPct > 50) p -= 0.04; // wild names miss stops/whipsaw
  // Anchor to reality: blend toward the lane's MEASURED win rate as samples accumulate
  // (10 samples → 33% weight, 30+ → 60% capped).
  if (laneWinRate != null && laneSamples >= 10) {
    const w = clamp(laneSamples / 50, 0.2, 0.6);
    p = p * (1 - w) + laneWinRate * w;
  }
  return clamp(+p.toFixed(3), 0.30, 0.75);
}

// Full edge computation. rewardRisk = { upsidePct, downsidePct, rr } from _scoring.rewardRisk.
export function expectedEdge({ confidence, regime, catalystPoints, annualizedVolPct, rewardRisk, laneWinRate, laneSamples } = {}) {
  const gain = rewardRisk?.upsidePct ?? 8;
  const loss = rewardRisk?.downsidePct ?? 5;
  const p = winProbability({ confidence, regime, catalystPoints, annualizedVolPct, laneWinRate, laneSamples });
  const edge = +(p * gain - (1 - p) * loss).toFixed(2);
  return { expectedGainPct: +gain.toFixed(1), expectedLossPct: +loss.toFixed(1), probability: p, edgePct: edge };
}

// Lane win-rate from the realized ledger (returns {winRate, samples}); null-safe on empty.
export function laneStats(realizedTrades, lane) {
  const t = (realizedTrades || []).filter(x => (x.entryLane || 'catalyst') === lane && x.realizedPnlPct != null);
  if (!t.length) return { winRate: null, samples: 0 };
  return { winRate: +(t.filter(x => x.realizedPnlPct > 0).length / t.length).toFixed(3), samples: t.length };
}
