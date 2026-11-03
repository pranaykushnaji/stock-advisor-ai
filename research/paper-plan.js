// Isolated experiment: never imported by production buy/sell endpoints.
import { quoteFreshness } from '../api/_upstox-market-data.js';

const positive = x => Number.isFinite(x) && x > 0;
const dayIST = ms => new Date(ms + 19800000).toISOString().slice(0, 10);

// Compare volume at the SAME exchange-session time, not a linear fraction of a day.
// Input bars are already normalized one-minute bars {ms, volume}. Missing minutes invalidate
// that reference day; missing data cannot manufacture an exceptionally high volume ratio.
export function sameTimeRelativeVolume({ current, history, nowMs, minimumSessions = 10 }) {
  const unavailable = reason => ({ status: 'unavailable', ratio: null, reason });
  if (!Number.isFinite(nowMs) || !Number.isInteger(minimumSessions) || minimumSessions < 1) return unavailable('invalid clock or session minimum');
  const shifted = new Date(nowMs + 19800000), cutoff = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const expected = cutoff - 555;
  if (expected < 1 || expected > 375) return unavailable('outside regular-session volume window');
  const today = dayIST(nowMs);
  const byDay = new Map();
  for (const [kind, rows] of [['current', current], ['history', history]]) {
    for (const b of rows || []) {
      if (!Number.isFinite(b.ms) || b.ms % 60000 || !Number.isFinite(b.volume) || b.volume < 0 || b.ms + 60000 > nowMs) continue;
      const date = dayIST(b.ms), t = new Date(b.ms + 19800000);
      const minute = t.getUTCHours() * 60 + t.getUTCMinutes();
      if (minute < 555 || minute >= cutoff || (kind === 'current' ? date !== today : date >= today)) continue;
      if (!byDay.has(date)) byDay.set(date, new Map());
      const day = byDay.get(date);
      if (day.has(minute) && day.get(minute) !== b.volume) return unavailable('conflicting duplicate volume');
      day.set(minute, b.volume);
    }
  }
  const sum = day => [...day.values()].reduce((s, x) => s + x, 0);
  const present = byDay.get(today);
  if (!present || present.size !== expected) return unavailable('incomplete current-session minutes');
  const baselines = [...byDay].filter(([d, bars]) => d < today && bars.size === expected)
    .sort(([a], [b]) => b.localeCompare(a)).slice(0, 20).map(([, bars]) => sum(bars));
  if (baselines.length < minimumSessions) return unavailable('insufficient complete same-time reference sessions');
  const average = baselines.reduce((s, x) => s + x, 0) / baselines.length;
  if (!(average > 0)) return unavailable('zero reference volume');
  return { status: 'measured', ratio: sum(present) / average, sessions: baselines.length,
    currentVolume: sum(present), referenceVolume: average, completedMinutes: expected };
}

// Amount-at-risk sizing: no confidence ladder or minimum spend that overrides reductions.
// All budgets must be chosen explicitly. Rupee losses remain estimates, never guarantees.
export function researchPositionPlan({ entryPrice, stopPrice, quote, nowMs,
  riskBudget, remainingDailyLossBudget, remainingDailyInvestmentBudget,
  cashAvailable, remainingExposureBudget, roundTripCostBps = 30,
  maxEntrySlippageBps = 10 } = {}) {
  const fail = reason => ({ status: 'blocked', reason, shares: 0, productionEnabled: false });
  if (![riskBudget, remainingDailyLossBudget, remainingDailyInvestmentBudget, cashAvailable, remainingExposureBudget].every(x => Number.isFinite(x) && x >= 0)) return fail('explicit capital and loss budgets required');
  if (!positive(entryPrice) || !positive(stopPrice) || stopPrice >= entryPrice) return fail('invalid entry or invalidation price');
  if (![roundTripCostBps, maxEntrySlippageBps].every(x => Number.isFinite(x) && x >= 0)) return fail('invalid execution-cost assumptions');
  if (!Number.isFinite(nowMs)) return fail('explicit observation time required');
  const fresh = quoteFreshness(quote, { nowMs });
  if (!fresh.fresh) return fail(fresh.reason);
  // Proposed fill is an ask quote where available, not a retrospectively selected low.
  const observedAsk = positive(quote.askPrice) ? quote.askPrice : quote.price;
  const fill = observedAsk * (1 + maxEntrySlippageBps / 10000);
  if (Math.abs(entryPrice / quote.price - 1) > 0.00001) return fail('entry must match current observed price');
  if (observedAsk < quote.price * 0.98) return fail('invalid ask relative to quote');
  const lossPerShare = fill - stopPrice + fill * roundTripCostBps / 10000;
  const riskCash = Math.min(riskBudget, remainingDailyLossBudget);
  const capital = Math.min(cashAvailable, remainingExposureBudget, remainingDailyInvestmentBudget);
  const shares = Math.floor(Math.min(riskCash / lossPerShare, capital / fill));
  if (shares < 1) return fail('budget cannot fund one whole share within stated risk');
  return { status: 'proposed', productionEnabled: false, shares, entryPrice: fill,
    observedPrice: quote.price, observedAt: quote.lastTradeAt, stopPrice,
    investedAmount: shares * fill, estimatedStopLoss: shares * lossPerShare,
    roundTripCostBps, maxEntrySlippageBps,
    limitation: 'Paper estimate only. Gaps, circuit locks and execution failures can exceed the stated risk budget.' };
}

// Preregistered alternate EXIT experiment. Production's broad swing trail remains unchanged.
// Separate activation, distance and cost floor. No fixed profit target; stops never loosen.
export const CONSERVATIVE_EXIT = Object.freeze({ version: 'risk-unit-trail-v1', activationR: 1.5, trailR: 1, roundTripCostBps: 30 });
export function researchExitObservation(position, quote, { nowMs, config = CONSERVATIVE_EXIT } = {}) {
  const state = { ...position };
  const invalid = reason => ({ status: 'unavailable', reason, state });
  if (!Number.isFinite(nowMs)) return invalid('explicit observation time required');
  if (!quoteFreshness(quote, { nowMs }).fresh) return invalid('unusable quote');
  if (!positive(state.entryPrice) || !positive(state.initialStopPrice) || state.initialStopPrice >= state.entryPrice) return invalid('missing frozen initial risk');
  if (!positive(config.activationR) || !positive(config.trailR) || !Number.isFinite(config.roundTripCostBps) || config.roundTripCostBps < 0) return invalid('invalid exit configuration');
  if (Date.parse(quote.lastTradeAt) <= (Date.parse(state.lastObservedAt) || 0)) return { status: 'duplicate-or-out-of-order', state };
  if (state.exitIntent) return { status: 'exit-latched', state, decision: state.exitIntent };
  const risk = state.entryPrice - state.initialStopPrice;
  state.peakPrice = Math.max(state.peakPrice || state.entryPrice, quote.price);
  state.lastObservedAt = quote.lastTradeAt;
  if (state.peakPrice - state.entryPrice >= risk * config.activationR) {
    const costFloor = state.entryPrice * (1 + config.roundTripCostBps / 10000);
    state.trailingStopPrice = Math.max(state.trailingStopPrice || 0, costFloor, state.peakPrice - risk * config.trailR);
  }
  const floor = Math.max(state.initialStopPrice, state.trailingStopPrice || 0);
  if (quote.price <= floor) {
    const fill = positive(quote.bidPrice) ? Math.min(quote.bidPrice, quote.price) : quote.price;
    state.exitIntent = { id: `${state.id}|${config.version}`, observedAt: quote.lastTradeAt,
      triggerPrice: floor, observedFillPrice: fill, reason: state.trailingStopPrice >= state.initialStopPrice ? 'experimental profit protection' : 'initial invalidation',
      grossReturnPct: (fill / state.entryPrice - 1) * 100,
      estimatedNetReturnPct: (fill / state.entryPrice - 1) * 100 - config.roundTripCostBps / 100,
      execution: 'shadow-observation-only' };
    return { status: 'exit-proposed', state, decision: state.exitIntent };
  }
  return { status: 'hold', state };
}
