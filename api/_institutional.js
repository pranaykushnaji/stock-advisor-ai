// api/_institutional.js
// PRIORITY 7 — INSTITUTIONAL ACCUMULATION SCORE.
// Big money accumulates BEFORE the obvious momentum move: steady buying on up-days, volume
// quietly expanding, closes finishing in the upper part of the daily range, day after day. This
// score tries to detect that footprint from the data we actually have, so discovery can favour
// stocks being accumulated over stocks merely bouncing.
//
// "If the available data supports it" (per the spec): we do NOT have per-symbol delivery% for the
// whole universe (the snapshot only samples one name) nor intraday VWAP, so those inputs are
// omitted rather than faked. What we CAN compute deterministically:
//   • Up/down volume ratio  — money-flow proxy: volume on up-days vs down-days (closes+volumes)
//   • Volume expansion      — recent avg volume vs its longer baseline
//   • Persistent buying      — fraction of recent sessions that closed up
//   • Closing strength       — where closes finish in the day range (needs daily OHLC; falls back
//                              to the up/down proxy when highs/lows aren't supplied)
//   • Bulk/block BUY today   — an explicit institutional print (boost)
//   • Today's closing strength from the live snapshot day-range (boost)
// Pure + deterministic. Returns 50 (neutral) with low confidence when history is too thin.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Up-day vs down-day volume over the last `lb` sessions → money-flow proxy score (0-100).
// Ratio > 1 means more volume traded on up-days than down-days = net accumulation.
function upDownVolumeScore(closes, volumes, lb = 15) {
  if (closes.length < lb + 1 || volumes.length < lb + 1) return null;
  let upVol = 0, downVol = 0;
  for (let i = closes.length - lb; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const v = volumes[i] || 0;
    if (chg > 0) upVol += v; else if (chg < 0) downVol += v;
  }
  if (upVol + downVol <= 0) return 50;
  const ratio = upVol / Math.max(1, downVol);   // >1 = accumulation
  return clamp(50 + (ratio - 1) * 45, 0, 100);   // ratio 2.1 ≈ 100, 0.5 ≈ 27
}

// Recent (5d) average volume vs its ~20d baseline → expansion score (0-100).
function volumeExpansionScore(volumes, recent = 5, baseline = 20) {
  const v = volumes.filter(x => x != null && isFinite(x) && x >= 0);
  if (v.length < baseline) return null;
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const r = avg(v.slice(-recent));
  const b = avg(v.slice(-baseline)) || 1;
  const ratio = r / b;                           // >1 = volume building
  return clamp(50 + (ratio - 1) * 55, 0, 100);
}

// Fraction of the last `lb` sessions that closed up → persistent buying pressure (0-100).
function persistentGainsScore(closes, lb = 10) {
  if (closes.length < lb + 1) return null;
  let up = 0;
  for (let i = closes.length - lb; i < closes.length; i++) if (closes[i] > closes[i - 1]) up++;
  return clamp((up / lb) * 100, 0, 100);
}

// Average closing strength over the last `lb` sessions when daily OHLC is available: (close-low)/
// (high-low). Near 100 = repeatedly closing on the highs = accumulation into strength.
function closingStrengthScore(highs, lows, closes, lb = 10) {
  if (!Array.isArray(highs) || !Array.isArray(lows)) return null;
  const n = closes.length;
  if (n < lb || highs.length !== n || lows.length !== n) return null;
  let sum = 0, cnt = 0;
  for (let i = n - lb; i < n; i++) {
    const range = highs[i] - lows[i];
    if (range > 0) { sum += (closes[i] - lows[i]) / range; cnt++; }
  }
  return cnt ? clamp((sum / cnt) * 100, 0, 100) : null;
}

// Combine into a 0-100 accumulation score. opts: { highs, lows, bulkBuy, todayClosingStrength }.
//   todayClosingStrength: 0-1 position of the live price in today's snapshot day-range.
export function institutionalAccumulationScore(closes, volumes, opts = {}) {
  const c = (closes || []).filter(v => v != null && isFinite(v));
  const vol = (volumes || []).filter(v => v != null && isFinite(v));
  if (c.length < 22 || vol.length < 22) {
    return { score: 50, confidence: 'low', components: {}, note: 'insufficient history' };
  }
  const components = {
    upDownVolume: upDownVolumeScore(c, vol),
    volumeExpansion: volumeExpansionScore(vol),
    persistentGains: persistentGainsScore(c),
    closingStrength: closingStrengthScore(opts.highs, opts.lows, c) ,
  };
  // Weighted blend over whatever components are present (renormalized).
  const W = { upDownVolume: 0.38, volumeExpansion: 0.24, persistentGains: 0.18, closingStrength: 0.20 };
  let acc = 0, wsum = 0;
  for (const [k, w] of Object.entries(W)) {
    if (components[k] != null && isFinite(components[k])) { acc += components[k] * w; wsum += w; }
  }
  let score = wsum > 0 ? acc / wsum : 50;

  // Explicit signals layered on top (capped).
  if (opts.bulkBuy) score = Math.min(100, score + 8);                 // an actual institutional print
  if (opts.todayClosingStrength != null) {                            // live: finishing today strong
    score = Math.min(100, score + (opts.todayClosingStrength - 0.5) * 12);
  }
  score = clamp(score, 0, 100);

  const flags = [];
  if (components.upDownVolume != null && components.upDownVolume >= 65) flags.push('up-day volume dominant');
  if (components.volumeExpansion != null && components.volumeExpansion >= 65) flags.push('volume expanding');
  if (components.closingStrength != null && components.closingStrength >= 65) flags.push('closing strong');
  if (opts.bulkBuy) flags.push('bulk/block buy');

  return {
    score: +score.toFixed(1),
    confidence: wsum >= 0.6 ? 'ok' : 'low',
    components: Object.fromEntries(Object.entries(components).filter(([, v]) => v != null).map(([k, v]) => [k, +v.toFixed(1)])),
    flags,
  };
}
