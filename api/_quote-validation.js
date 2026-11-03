// Quote age is distinct from retrieval time. Daily bars cannot establish a live fill.
export function quoteBase(symbol) {
  const base = String(symbol || '').toUpperCase().replace(/\.(NS|BO|BSE)$/, '');
  return ({ ZOMATO: 'ETERNAL', MOTHERSUMI: 'MOTHERSON', MINDTREE: 'LTIM' })[base] || base;
}

export function validateQuote(meta, ticker, now = new Date()) {
  if (!Number.isFinite(meta?.regularMarketPrice) || meta.regularMarketPrice <= 0
    || meta.currency !== 'INR' || !/\.(NS|BO)$/i.test(meta.symbol || '')
    || quoteBase(meta.symbol) !== quoteBase(ticker)) return null;
  const ms = meta.regularMarketTime * 1000;
  if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) return null;
  const ist = new Date(now.getTime() + 19800000);
  const sessionDate = ist.toISOString().slice(0, 10);
  if (new Date(ms + 19800000).toISOString().slice(0, 10) !== sessionDate) return null;
  const close = Date.parse(`${sessionDate}T15:30:00+05:30`);
  // During trading: five minutes. After close: retain only a quote near the session close.
  const reference = Math.min(now.getTime(), close);
  if (ms > now.getTime() + 30000 || reference - ms > 300000
    || ['PRE', 'PREPRE'].includes(String(meta.marketState || '').toUpperCase())) return null;
  return { quoteTimestamp: new Date(ms).toISOString(), quoteSymbol: meta.symbol,
    quoteCurrency: meta.currency, quoteSource: 'yahoo' };
}
