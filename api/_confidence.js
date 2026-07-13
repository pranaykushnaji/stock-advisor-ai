// api/_confidence.js
// V2 MODULAR CONFIDENCE — four INDEPENDENT 0-100 component scores instead of one mixed number,
// combined into Effective Confidence with configurable weights. Every candidate and trade
// stores all four components, so analytics can later answer "which component predicts winners?"
// per component instead of per blended blob.
//
// LANE-AWARE COMBINE: the momentum lane exists precisely for stocks with NO catalyst, so its
// effective confidence excludes the Catalyst component (renormalized) — otherwise every
// momentum candidate would eat a structural ~25-point penalty for a component that is zero by
// definition. The catalyst lane uses all four. Component values are identical either way; only
// the combination differs. Weights are calibrated so the existing regime gate bars
// (55/62/72/75, +6 momentum) keep their meaning — verified against 2026-07-10's real numbers
// (PAYTM-like passes the 68 momentum bar, BANDHANBNK-like fails).

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Configurable combine weights (catalyst lane uses all; momentum lane drops `catalyst` and
// renormalizes the rest).
export const CONFIDENCE_WEIGHTS = { technical: 0.30, flow: 0.30, catalyst: 0.25, liquidity: 0.15 };

// ---- TECHNICAL: trend structure + momentum quality + breakout position ----
// inputs: { techScore, momentumRank, relStrengthRank, maAlignment, aboveEma200,
//           roomTo52wHighPct, shortReturns }
export function technicalScore(i = {}) {
  const parts = [];
  if (i.techScore != null) parts.push({ v: i.techScore, w: 0.30 });               // RSI/MACD/MA blend
  if (i.momentumRank != null) parts.push({ v: i.momentumRank, w: 0.25 });          // vol-scaled momentum rank
  if (i.relStrengthRank != null) parts.push({ v: i.relStrengthRank, w: 0.20 });    // RS vs Nifty rank
  if (i.maAlignment != null) parts.push({ v: i.maAlignment, w: 0.10 });            // EMA stack quality
  // Higher-highs proxy: both the week and the month trending up.
  const r1w = i.shortReturns?.r1w, r1m = i.shortReturns?.r1m;
  if (r1w != null && r1m != null) parts.push({ v: (r1w > 0 && r1m > 0) ? 85 : (r1m > 0 ? 55 : 25), w: 0.08 });
  // Breakout position: close to the 52-week high without being extended.
  if (i.roomTo52wHighPct != null) {
    const room = i.roomTo52wHighPct;
    parts.push({ v: room <= 2 ? 88 : room <= 5 ? 78 : room <= 8 ? 62 : 40, w: 0.07 });
  }
  if (i.aboveEma200 === false) return finish(parts, -8);   // trading under the 200-EMA drags the whole score
  return finish(parts, 0);
}

// ---- FLOW: is real money actually coming in? ----
// inputs: { relVol, volumeRank, institutional (score 0-100), instFlags }
export function flowScore(i = {}) {
  const parts = [];
  if (i.institutional != null) parts.push({ v: i.institutional, w: 0.40 });                 // accumulation footprint
  if (i.relVol != null) parts.push({ v: clamp((i.relVol / 3) * 100, 0, 100), w: 0.35 });    // 3x pace ≈ 100
  if (i.volumeRank != null) parts.push({ v: i.volumeRank, w: 0.25 });                       // cross-sectional volume rank
  const bulk = (i.instFlags || []).includes('bulk/block buy');
  return finish(parts, bulk ? 6 : 0);
}

// ---- CATALYST: verified information edge ----
// inputs: { points (0-40), verification, decay, impactClass, recalled }
export function catalystScore(i = {}) {
  if (!i || i.points == null || i.points <= 0) return 5; // no information edge (floor, not zero — absence isn't disqualifying)
  let s = clamp(i.points * 2.2, 0, 88);                  // 40 pts (max) ≈ 88
  if (i.verification === 'VERIFIED') s = Math.max(s, 60); // any verified catalyst is meaningful
  if (String(i.impactClass || '').startsWith('very-high')) s += 8;
  if (i.recalled) s -= 6;                                 // remembered (decayed) beats nothing, trails fresh
  return clamp(Math.round(s), 0, 100);
}

// ---- LIQUIDITY: can this actually be traded cleanly? ----
// inputs: { tradedValueCr, price }
// (Spread/execution data isn't available from our sources — traded value is the honest proxy.)
export function liquidityScore(i = {}) {
  const tv = i.tradedValueCr;
  if (tv == null || tv <= 0) return 50; // unknown — neutral, never disqualifying on missing data
  let s = clamp(38 * Math.log10(tv / 3), 0, 95);   // ₹75Cr≈53, ₹300Cr≈76, ₹1000Cr+≈95
  if (i.price != null && i.price < 50) s -= 10;     // low-price names execute worse
  return clamp(Math.round(s), 0, 100);
}

function finish(parts, bonus) {
  if (!parts.length) return 50;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  return clamp(Math.round(parts.reduce((a, p) => a + p.v * p.w, 0) / wsum + bonus), 0, 100);
}

// Compute all four components from a candidate's assembled inputs.
export function confidenceComponents(inputs = {}) {
  return {
    technical: technicalScore(inputs.technical || {}),
    flow: flowScore(inputs.flow || {}),
    catalyst: catalystScore(inputs.catalyst || {}),
    liquidity: liquidityScore(inputs.liquidity || {}),
  };
}

// Combine components into effective confidence for a lane. `extras` = additive adjustments the
// engine already earns elsewhere (intraday trend bonus etc.); regimeScore blends 15% like v1.
export function effectiveConfidence(components, lane = 'catalyst', { regimeScore = null, extras = 0, weights = CONFIDENCE_WEIGHTS } = {}) {
  return explainConfidence(components, lane, { regimeScore, extras, weights }).final;
}

// V2.1 EXPLAINABLE CONFIDENCE — same math as effectiveConfidence, but returns the full working:
// each component's weighted contribution, the regime blend's effect, and the additive extras.
// Stored on every pick/position so any confidence number can be audited after the fact.
export function explainConfidence(components, lane = 'catalyst', { regimeScore = null, extras = 0, weights = CONFIDENCE_WEIGHTS } = {}) {
  const use = { ...weights };
  if (lane === 'momentum') delete use.catalyst;   // no-catalyst lane: don't punish the definition
  const wsum = Object.entries(use).reduce((a, [k, w]) => a + (components[k] != null ? w : 0), 0);
  const contributions = {};
  let base = 0;
  for (const [k, w] of Object.entries(use)) {
    if (components[k] == null) continue;
    const normW = w / (wsum || 1);
    contributions[k] = { score: components[k], weight: +normW.toFixed(3), contribution: +(components[k] * normW).toFixed(1) };
    base += components[k] * normW;
  }
  if (wsum === 0) base = 50;
  const afterRegime = regimeScore != null ? base * 0.85 + regimeScore * 0.15 : base;
  const regimeAdjustment = +(afterRegime - base).toFixed(1);
  const final = clamp(+(afterRegime + extras).toFixed(1), 0, 100);
  return {
    final,
    breakdown: {
      lane,
      contributions,                     // per-component: raw score, normalized weight, points contributed
      base: +base.toFixed(1),            // weighted component blend
      regimeScore, regimeAdjustment,     // what the 15% regime blend added/removed
      trendBonus: +(+extras).toFixed(1), // intraday confidence-evolution bonus (institutional
                                         // influence lives inside the flow component in v2)
      final,
    },
  };
}
