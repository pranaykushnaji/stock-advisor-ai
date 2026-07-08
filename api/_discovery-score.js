// api/_discovery-score.js
// PRIORITY 1 — the composite DISCOVERY SCORE that decides which names get the (expensive)
// downstream 1y-price + catalyst processing.
//
// The old discovery stage ranked purely by today's % gain, so the compute budget was spent on
// stocks that had ALREADY made their move, while quietly-strengthening names were ignored. This
// module scores each snapshot universe row on signals that lead — or at least coincide with the
// START of — a momentum move, rather than confirming one that's over:
//
//   • closing strength   — where the last price sits in the day's range (accumulation into highs)
//   • contained momentum — reward a healthy up-move, PENALISE a blown-out gap (already moved)
//   • breadth-relative   — beating the universe's median move today (relative strength proxy)
//   • liquidity          — enough traded value to actually trade (and to trust the signal)
//   • sector strength    — a rising tide behind the name (passed in from _sector.js)
//   • catalyst present   — a fresh official filing / announcement exists (cheap set lookup)
//   • institutional      — bulk/block BUY today (cheap set lookup)
//   • volume acceleration— (optional) this scan's volume-rate vs the previous scan's, from the
//                          intraday store — a REAL "surging right now" signal across hourly scans
//
// Everything here is computed from CHEAP snapshot fields only (no per-name history fetch), so it
// stays inside the discovery budget. True RVOL / RS / EMA confirmation happen downstream on the
// shortlist this score selects. Pure + deterministic → reused by the buy-scan and (partially) the
// backtest.

// Blend weights for the base score (before the catalyst/institutional additive bonuses).
// Tuned so "quietly strengthening" beats "already gapped": closing strength + breadth-relative
// strength + volume acceleration dominate; raw momentum is deliberately a minor, capped input.
const W = {
  closingStrength: 0.24,
  containedMomentum: 0.14,
  breadthRelative: 0.20,
  liquidity: 0.12,
  sector: 0.14,
  volAccel: 0.16,
};
// Additive bonuses (points added on top of the 0-100 weighted base, then re-clamped).
const CATALYST_BONUS = 10;      // a fresh verified-able filing exists for this name
const INSTITUTIONAL_BONUS = 8;  // bulk/block BUY printed today

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Where the last price sits within the day's range → 0-100 (near 100 = closing on its highs).
// Neutral 50 when there's no usable range (e.g. circuit-locked or missing H/L).
function closingStrengthScore(last, dayHigh, dayLow) {
  if (last == null || dayHigh == null || dayLow == null || dayHigh <= dayLow) return 50;
  return clamp(((last - dayLow) / (dayHigh - dayLow)) * 100, 0, 100);
}

// Reward a HEALTHY up-move, penalise both weakness and a blown-out gap that's already moved.
// Peak reward around +2-4%; tapers above +6%; hard penalty for >+12% (chased) and for negatives.
function containedMomentumScore(pChange) {
  if (pChange == null || !isFinite(pChange)) return 50;
  if (pChange <= -3) return clamp(30 + pChange, 0, 30);          // falling — low
  if (pChange < 0) return 45 + pChange;                          // slightly red — below neutral
  if (pChange <= 4) return 60 + pChange * 7.5;                   // 0→60, 4%→90 (the sweet spot)
  if (pChange <= 8) return 90 - (pChange - 4) * 6;               // 4→90, 8%→66 (getting late)
  if (pChange <= 12) return 66 - (pChange - 8) * 9;              // 8→66, 12%→30 (chased)
  return clamp(30 - (pChange - 12) * 3, 0, 30);                  // blown out — already moved
}

// Relative strength PROXY without history: how far this name's move beats the universe median
// today. Beating breadth = leadership. ±5% around the median maps to roughly ±40 points.
function breadthRelativeScore(pChange, medianPChange) {
  if (pChange == null || medianPChange == null) return 50;
  return clamp(50 + (pChange - medianPChange) * 8, 0, 100);
}

// Traded value (₹Cr) → a soft liquidity curve. ~₹5Cr floor scores ~0, ₹75Cr ~70, ₹300Cr+ ~95.
function liquidityScore(tradedValueCr) {
  if (tradedValueCr == null || tradedValueCr <= 0) return 0;
  // Log curve so the score saturates gracefully for the very liquid large-caps.
  return clamp(38 * Math.log10(tradedValueCr / 3), 0, 95);
}

// Cross-scan volume acceleration → 0-100. Compares the per-session-fraction volume RATE of this
// scan vs the previous scan for the same name. rate = volume / sessionFraction (so partial-day
// volume is normalised). accel > 1 = volume building faster than earlier in the day. Neutral 50
// when there's no previous scan to compare against (first scan of the day).
function volAccelScore(curVol, curFrac, prevVol, prevFrac) {
  if (!curVol || !prevVol || !curFrac || !prevFrac) return 50;
  const curRate = curVol / curFrac;
  const prevRate = prevVol / prevFrac;
  if (prevRate <= 0) return 50;
  const accel = curRate / prevRate;         // >1 = accelerating
  return clamp(50 + (accel - 1) * 60, 0, 100);
}

// Score a single snapshot universe row. ctx carries the cheap context signals.
//   row = { symbol, pChange, lastPrice, dayHigh, dayLow, totalTradedVolume }
//   ctx = { sectorScore, hasCatalyst, institutional, medianPChange, tradedValueCr,
//           curFrac, prevVolume, prevFrac }
export function computeDiscoveryScore(row, ctx = {}) {
  const last = row.lastPrice, vol = row.totalTradedVolume;
  const tradedValueCr = ctx.tradedValueCr ?? ((last && vol) ? (last * vol) / 1e7 : null);

  const parts = {
    closingStrength: closingStrengthScore(last, row.dayHigh, row.dayLow),
    containedMomentum: containedMomentumScore(row.pChange),
    breadthRelative: breadthRelativeScore(row.pChange, ctx.medianPChange),
    liquidity: liquidityScore(tradedValueCr),
    sector: (ctx.sectorScore != null && isFinite(ctx.sectorScore)) ? ctx.sectorScore : 50,
    volAccel: volAccelScore(vol, ctx.curFrac, ctx.prevVolume, ctx.prevFrac),
  };

  let base = 0, wsum = 0;
  for (const [k, w] of Object.entries(W)) { base += parts[k] * w; wsum += w; }
  base = wsum > 0 ? base / wsum : 50;

  let score = base;
  if (ctx.hasCatalyst) score += CATALYST_BONUS;
  if (ctx.institutional) score += INSTITUTIONAL_BONUS;
  score = clamp(score, 0, 100);

  // Human-readable "why this scored where it did" for the intraday store / diagnostics.
  const reasons = [];
  if (parts.closingStrength >= 70) reasons.push('closing near highs');
  else if (parts.closingStrength <= 30) reasons.push('closing near lows');
  if (parts.breadthRelative >= 70) reasons.push('leading market breadth');
  if (parts.volAccel >= 65) reasons.push('volume accelerating');
  if (row.pChange != null && row.pChange > 10) reasons.push('already gapped (chased)');
  if (ctx.hasCatalyst) reasons.push('fresh filing');
  if (ctx.institutional) reasons.push('bulk/block buy');
  if (tradedValueCr != null && tradedValueCr < 5) reasons.push('thin liquidity');

  return { score: +score.toFixed(1), parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(1)])), tradedValueCr: tradedValueCr != null ? +tradedValueCr.toFixed(1) : null, reasons };
}

// Median of a numeric array (used for the breadth-relative signal). Null on empty.
export function median(nums) {
  const v = (nums || []).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Rank a whole snapshot universe by discovery score. Returns rows sorted desc, each annotated
// with { discoveryScore, discoveryParts, discoveryReasons }. ctxFor(row) supplies per-row context
// (sector score, catalyst/institutional flags, prev-scan volume). marketMedian is computed here
// from the universe so callers don't have to.
export function rankByDiscoveryScore(rows, ctxFor) {
  const medianPChange = median((rows || []).map(r => r.pChange));
  const scored = (rows || []).map(row => {
    const ctx = { medianPChange, ...(ctxFor ? ctxFor(row) : {}) };
    const d = computeDiscoveryScore(row, ctx);
    return { ...row, discoveryScore: d.score, discoveryParts: d.parts, discoveryReasons: d.reasons, tradedValueCr: d.tradedValueCr };
  });
  scored.sort((a, b) => (b.discoveryScore ?? -1) - (a.discoveryScore ?? -1));
  return scored;
}
