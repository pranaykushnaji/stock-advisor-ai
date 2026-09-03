import { marketStatus, nowIST } from './_market-calendar.js';

// Entry day is day zero. Reuse the exchange calendar, not calendar-day arithmetic.
export function tradingSessionsHeld(entryDate, now = new Date()) {
  const end = nowIST(now).ymd;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate || '') || entryDate > end) return 0;
  let count = 0;
  const d = new Date(`${entryDate}T06:00:00Z`);
  if (!Number.isFinite(d.getTime())) return 0;
  for (d.setUTCDate(d.getUTCDate() + 1); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (marketStatus(d).open) count++;
  }
  return count;
}

export function seedRisk(item, bands, now = new Date(), source = 'entry') {
  if (!(item.entryPrice > 0)) return item;
  if (!(item.initialStopPrice > 0)) {
    item.initialStopPct = bands.stopPct;
    item.initialStopPrice = item.entryPrice * (1 - bands.stopPct / 100);
    item.initialTrailPct = bands.trailPct;
    item.riskInitializedAt = now.toISOString();
    item.riskSource = source;
  }
  return item;
}

// Daily highs are usable only when the entire candle follows the entry date.
// On entry day, only observed post-entry quotes are safe without intraday bars.
export function observePrice(item, price, { dayHigh = null, highDate = null, observedAt = new Date().toISOString() } = {}) {
  if (!(price > 0) || !Number.isFinite(price)) return item;
  const eligibleHigh = highDate && item.date && highDate > item.date ? dayHigh : null;
  item.currentPrice = price;
  item.peakPrice = Math.max(item.entryPrice || price, item.peakPrice || 0, price,
    Number.isFinite(eligibleHigh) && eligibleHigh > 0 ? eligibleHigh : 0);
  item.lastPriceUpdate = observedAt;
  return item;
}

// Merge with the newest GitHub version: concurrent updates must never lower a peak or
// trailing protection, or replace an already frozen initial stop.
export function mergeRiskState(existing, observed) {
  const out = {};
  for (const field of ['initialStopPrice', 'initialStopPct', 'initialTrailPct', 'riskInitializedAt', 'riskSource']) {
    if (existing[field] != null || observed[field] != null) out[field] = existing[field] ?? observed[field];
  }
  out.peakPrice = Math.max(existing.peakPrice || existing.entryPrice || 0, observed.peakPrice || 0);
  if (existing.trailingStopPrice > 0 || observed.trailingStopPrice > 0) {
    out.trailingStopPrice = Math.max(existing.trailingStopPrice || 0, observed.trailingStopPrice || 0);
  }
  if (Date.parse(observed.lastPriceUpdate || '') >= (Date.parse(existing.lastPriceUpdate || '') || 0)) {
    out.currentPrice = observed.currentPrice;
    out.lastPriceUpdate = observed.lastPriceUpdate;
  } else {
    out.currentPrice = existing.currentPrice;
    out.lastPriceUpdate = existing.lastPriceUpdate;
  }
  return out;
}
