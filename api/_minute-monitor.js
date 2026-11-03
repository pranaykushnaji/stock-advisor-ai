import { nowIST, marketStatus } from './_market-calendar.js';
import { priceRiskGate, isSuspiciousMove } from './_sell-engine.js';
import { observePrice, tradingSessionsHeld } from './_position-risk.js';
import { quoteFreshness } from './_upstox-market-data.js';

export function monitorSession(now = new Date()) {
  const market = marketStatus(now);
  const ist = new Date(now.getTime() + 19800000);
  const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return { ...market, open: market.open && minute >= 555 && minute < 930,
    reason: !market.open ? market.reason : minute >= 555 && minute < 930 ? 'regular-session' : 'outside-regular-session' };
}

export function positionIdentity(p) {
  return `${p.ticker}|${p.date}|${p.addedAt || p.entryPrice}`;
}

const finitePositive = value => Number.isFinite(value) && value > 0;

// Pure transition: returns separate shadow state and observations; never mutates holdings,
// calls a broker, books exits or writes the GitHub ledger. Replayed/out-of-order quotes cannot
// raise peaks or emit duplicate signals. A signal stays latched until that position disappears.
export function evaluateMonitor(positions, quotes, mappings, previous = {}, { now = new Date() } = {}) {
  const nowMs = now.getTime(), slot = new Date(Math.floor(nowMs / 60000) * 60000).toISOString();
  const state = { version: 1, date: nowIST(now).ymd, positions: {} };
  const results = [];
  for (const source of positions) {
    const id = positionIdentity(source), key = mappings[source.ticker];
    const prior = previous?.version === 1 ? previous.positions?.[id] : null;
    const priorValid = prior?.instrumentKey === key && prior?.entryPrice === source.entryPrice;
    if (prior?.entryPrice === source.entryPrice) state.positions[id] = structuredClone(prior);
    const result = { ticker: source.ticker, positionId: id, instrumentKey: key || null };
    const emit = (status, extra = {}) => results.push({ ...result, status, ...extra });
    if (!key) { emit('unmapped'); continue; }
    const quote = quotes[key], freshness = quoteFreshness(quote, { nowMs });
    if (!freshness.fresh) { emit('unusable_price', { reason: freshness.reason, ageMs: freshness.ageMs }); continue; }
    if (quote.symbol && quote.symbol !== source.ticker) { emit('identity_mismatch'); continue; }
    const quoteMs = Date.parse(quote.lastTradeAt);
    if (source.addedAt && quoteMs < Date.parse(source.addedAt)) { emit('pre_entry_quote'); continue; }
    if (priorValid && quoteMs <= Date.parse(prior.lastTradeAt || '')) {
      emit('duplicate_quote', { lastTradeAt: quote.lastTradeAt }); continue;
    }
    // Missing legacy entry risk is explicit; a minute quote cannot reconstruct entry volatility.
    if (!finitePositive(source.entryPrice) || !finitePositive(source.initialStopPrice)
      || source.initialStopPrice >= source.entryPrice || !finitePositive(source.initialStopPct)
      || !finitePositive(source.initialTrailPct)) { emit('missing_frozen_risk'); continue; }
    const held = tradingSessionsHeld(source.date, now);
    const pnl = (quote.price / source.entryPrice - 1) * 100;
    if (isSuspiciousMove(pnl, held)) { emit('extreme_move_unverified', { price: quote.price }); continue; }

    const copy = { ...source,
      peakPrice: Math.max(source.entryPrice, source.peakPrice || 0, priorValid ? prior.peakPrice || 0 : 0),
      trailingStopPrice: Math.max(source.trailingStopPrice || 0, priorValid ? prior.trailingStopPrice || 0 : 0) };
    observePrice(copy, quote.price, { observedAt: quote.lastTradeAt });
    const decision = priceRiskGate(copy, null, { heldSessions: held });
    const signal = priorValid && prior.signal ? prior.signal : decision ? {
      id: `${id}|price-stop`, at: now.toISOString(), quoteAt: quote.lastTradeAt,
      observedPrice: quote.price, triggerPrice: decision.triggerPrice, reason: decision.reason,
      execution: 'shadow-only-no-fill',
    } : null;
    state.positions[id] = { instrumentKey: key, entryPrice: source.entryPrice,
      peakPrice: copy.peakPrice, trailingStopPrice: copy.trailingStopPrice || null,
      lastTradeAt: quote.lastTradeAt, observedAt: now.toISOString(), signal };
    emit(signal ? (priorValid && prior.signal ? 'signal_latched' : 'would_sell') : 'hold', {
      price: quote.price, lastTradeAt: quote.lastTradeAt, peakPrice: copy.peakPrice,
      initialStopPrice: copy.initialStopPrice, trailingStopPrice: copy.trailingStopPrice || null,
      signal, newSignal: !!signal && !(priorValid && prior.signal),
    });
  }
  return { status: results.some(r => ['unmapped', 'unusable_price', 'identity_mismatch', 'pre_entry_quote', 'missing_frozen_risk', 'extreme_move_unverified'].includes(r.status))
    ? 'monitor_incomplete' : 'monitored', mode: 'read-only-shadow', paperTrading: true,
  slot, evaluatedAt: now.toISOString(), positions: results, nextState: state,
  signals: results.filter(r => r.newSignal).map(r => r.signal) };
}
