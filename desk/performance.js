// Read-only presentation arithmetic. Never used to authorize an order or alter the ledger.
const finite = n => typeof n === 'number' && Number.isFinite(n);
const positive = n => finite(n) && n > 0;
export const excludedFromPerformance = r => !!(r?.synthetic || r?.historicalReplay || r?.backdated || r?.voided || r?.excludeFromLiveStatistics);
export function entryCapital(row) {
  return positive(row?.investedAmount) ? row.investedAmount
    : positive(row?.shares) && positive(row?.entryPrice) ? row.shares * row.entryPrice : null;
}
export function estimatedTradeCost(row) {
  if (finite(row?.estimatedCostAmount) && row.estimatedCostAmount >= 0) return row.estimatedCostAmount;
  if (finite(row?.entryCost) && row.entryCost >= 0 && finite(row?.exitCost) && row.exitCost >= 0) return row.entryCost + row.exitCost;
  const basis = entryCapital(row);
  return basis === null ? null : basis * 0.003;
}
export function tradeNetAmount(row) {
  if (excludedFromPerformance(row)) return null;
  if (finite(row?.realizedNetPnl)) return row.realizedNetPnl;
  const gross = finite(row?.realizedPnl) ? row.realizedPnl
    : positive(row?.shares) && positive(row?.entryPrice) && positive(row?.exitPrice)
      ? (row.exitPrice - row.entryPrice) * row.shares : null;
  const cost = estimatedTradeCost(row);
  return gross !== null && cost !== null ? gross - cost : null;
}
export function tradeNetReturnPct(row) {
  const basis = entryCapital(row), net = tradeNetAmount(row);
  return basis !== null && net !== null ? net / basis * 100 : null;
}
export function positionReturnPct(row) {
  return positive(row?.currentPrice) && positive(row?.entryPrice)
    ? (row.currentPrice / row.entryPrice - 1) * 100 : null;
}
export function performanceSummary(sim) {
  if (!sim || !Array.isArray(sim.trades) || !Array.isArray(sim.positions)) return null;
  const all = [...sim.trades, ...sim.positions];
  const excluded = all.filter(excludedFromPerformance), included = all.filter(r => !excludedFromPerformance(r));
  const identities = included.map(r => r.id || [r.ticker, r.entryAt || r.addedAt || r.entryDate || r.date].join('|'));
  const duplicateCount = identities.length - new Set(identities).size;
  const openTickers = sim.positions.map(r => r.ticker);
  const duplicateOpenTickers = openTickers.length - new Set(openTickers).size;
  const closed = sim.trades.filter(r => !excludedFromPerformance(r));
  const completeClosed = !duplicateCount && closed.every(r => entryCapital(r) !== null && tradeNetAmount(r) !== null && typeof r.ticker==='string' && r.ticker.trim());
  const closedCapital = completeClosed ? closed.reduce((s, r) => s + entryCapital(r), 0) : null;
  const closedNet = completeClosed ? closed.reduce((s, r) => s + tradeNetAmount(r), 0) : null;
  const perStock = new Map();
  if (completeClosed) for (const r of closed) {
    const key = r.ticker.trim().toUpperCase(), a = perStock.get(key) || { net: 0, capital: 0 };
    a.net += tradeNetAmount(r); a.capital += entryCapital(r); perStock.set(key, a);
  }
  // Re-entries are aggregated per ticker first: each stock gets equal weight in this mean.
  const averageClosedStockPct = perStock.size ? [...perStock.values()].reduce((s, r) => s + r.net / r.capital * 100, 0) / perStock.size : null;
  const validAccount = !duplicateCount && !duplicateOpenTickers && !excluded.length && finite(sim.cash) && sim.cash >= 0
    && finite(sim.contributions) && sim.contributions >= 0
    && sim.positions.every(r => positive(r.currentPrice) && positive(r.shares) && entryCapital(r) !== null);
  const equity = validAccount ? sim.cash + sim.positions.reduce((s, r) => s + r.currentPrice * r.shares, 0) : null;
  const accountPnl = equity === null ? null : equity - sim.contributions;
  const deployedCapital = included.every(r => entryCapital(r) !== null) && !duplicateCount
    ? included.reduce((s, r) => s + entryCapital(r), 0) : null;
  const ratio = (net, base) => net !== null && base > 0 ? net / base * 100 : null;
  return { closedNet, closedCapital, averageClosedStockPct, closedStocks: perStock.size,
    closedWeightedPct: ratio(closedNet, closedCapital), equity, accountPnl,
    accountReturnPct: ratio(accountPnl, sim.contributions), deployedCapital,
    deployedReturnPct: ratio(accountPnl, deployedCapital), excludedCount: excluded.length,
    duplicateCount, duplicateOpenTickers, closedCount: closed.length };
}
