// One source of truth for daily limits and session-scoped de-duplication.
// Sold positions leave the bouquet, so both the open bouquet AND realized ledger must be read.

export function isOpenPosition(row = {}) {
  return !row.status || row.status === 'OPEN' || row.status === 'SELL_PENDING';
}

export function tradeSessionState(bouquet = [], realized = [], date) {
  const boughtToday = new Set();
  const exitedToday = new Set();
  const openTickers = new Set();
  let momentumBuysToday = 0;

  for (const row of bouquet || []) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (isOpenPosition(row)) openTickers.add(ticker);
    if (row.date === date) {
      boughtToday.add(ticker);
      if (row.entryLane === 'momentum') momentumBuysToday++;
    }
  }

  for (const row of realized || []) {
    const ticker = String(row?.ticker || '').toUpperCase();
    if (!ticker) continue;
    if (row.entryDate === date) {
      if (!boughtToday.has(ticker) && row.entryLane === 'momentum') momentumBuysToday++;
      boughtToday.add(ticker);
    }
    if (row.exitDate === date) exitedToday.add(ticker);
  }

  return {
    boughtToday,
    exitedToday,
    openTickers,
    blockedTickers: new Set([...openTickers, ...boughtToday, ...exitedToday]),
    boughtCount: boughtToday.size,
    momentumBuysToday,
  };
}
