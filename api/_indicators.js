// api/_indicators.js
// Classic technical indicators computed from a close-price series (oldest -> newest).
// Pure functions, no external data. Feed the momentum-swing scoring as confirmation
// signals (trend strength, overbought/oversold, trend alignment, relative strength).
// All functions tolerate short series by returning null rather than throwing.

export function sma(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function emaSeries(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(closes, period) {
  const s = emaSeries(closes, period);
  return s ? s[s.length - 1] : null;
}

// RSI (Wilder's smoothing). 0-100. >70 overbought, <30 oversold.
export function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff >= 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

// MACD 12/26/9 → { macd, signal, histogram }.
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  if (!emaFast || !emaSlow) return null;
  const macdLine = closes.map((_, i) =>
    (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const macdVals = macdLine.filter(v => v != null);
  if (macdVals.length < signalPeriod) return null;
  const sigSeries = emaSeries(macdVals, signalPeriod);
  if (!sigSeries) return null;
  const macdNow = macdVals[macdVals.length - 1];
  const signalNow = sigSeries[sigSeries.length - 1];
  return { macd: +macdNow.toFixed(3), signal: +signalNow.toFixed(3), histogram: +(macdNow - signalNow).toFixed(3) };
}

// MA alignment: price vs 20/50/200 SMAs + bullish stacking → 0-100.
export function maAlignment(closes) {
  if (!Array.isArray(closes) || closes.length < 50) return null;
  const price = closes[closes.length - 1];
  const ma20 = sma(closes, 20), ma50 = sma(closes, 50);
  const ma200 = closes.length >= 200 ? sma(closes, 200) : null;
  let score = 0, checks = 0;
  if (ma20 != null) { checks++; if (price > ma20) score++; }
  if (ma50 != null) { checks++; if (price > ma50) score++; }
  if (ma200 != null) { checks++; if (price > ma200) score++; }
  if (ma20 != null && ma50 != null) { checks++; if (ma20 > ma50) score++; }
  if (ma50 != null && ma200 != null) { checks++; if (ma50 > ma200) score++; }
  return checks ? +((score / checks) * 100).toFixed(1) : null;
}

// Relative strength vs benchmark (Nifty): stock excess return over `lookback` days (%).
export function relativeStrength(closes, benchCloses, lookback = 21) {
  if (!Array.isArray(closes) || !Array.isArray(benchCloses)) return null;
  if (closes.length < lookback + 1 || benchCloses.length < lookback + 1) return null;
  const sNow = closes[closes.length - 1], sThen = closes[closes.length - 1 - lookback];
  const bNow = benchCloses[benchCloses.length - 1], bThen = benchCloses[benchCloses.length - 1 - lookback];
  if (!sThen || !bThen) return null;
  return +(((sNow - sThen) / sThen * 100) - ((bNow - bThen) / bThen * 100)).toFixed(2);
}

// ATR% (volatility as % of price) for stop-sizing.
export function atrPct(highs, lows, closes, period = 14) {
  if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) return null;
  const n = closes.length;
  if (n < period + 1 || highs.length !== n || lows.length !== n) return null;
  const trs = [];
  for (let i = 1; i < n; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  const price = closes[n - 1];
  return price ? +((atr / price) * 100).toFixed(2) : null;
}

// Bundle all indicators + a 0-100 technical-strength composite.
export function computeIndicators(closes, { highs, lows, benchCloses } = {}) {
  const rsiVal = rsi(closes);
  const macdVal = macd(closes);
  const maAlign = maAlignment(closes);
  const relStr = benchCloses ? relativeStrength(closes, benchCloses) : null;
  const atr = (highs && lows) ? atrPct(highs, lows, closes) : null;

  const parts = [];
  if (rsiVal != null) {
    let rsiScore;
    if (rsiVal >= 50 && rsiVal <= 70) rsiScore = 90;       // momentum sweet spot
    else if (rsiVal > 70 && rsiVal <= 78) rsiScore = 65;
    else if (rsiVal > 78) rsiScore = 35;                   // overbought risk
    else if (rsiVal >= 40) rsiScore = 55;
    else rsiScore = 30;
    parts.push(rsiScore);
  }
  if (macdVal) parts.push(macdVal.histogram > 0 ? (macdVal.macd > 0 ? 85 : 65) : 35);
  if (maAlign != null) parts.push(maAlign);
  if (relStr != null) parts.push(relStr > 0 ? Math.min(90, 55 + relStr * 2) : Math.max(20, 45 + relStr * 2));

  const techScore = parts.length ? +(parts.reduce((a, b) => a + b, 0) / parts.length).toFixed(1) : null;
  return { rsi: rsiVal, macd: macdVal, maAlignment: maAlign, relativeStrength: relStr, atrPct: atr, techScore };
}
