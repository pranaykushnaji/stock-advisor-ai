// Stock price + history endpoint.
// Primary: Yahoo Finance (no key, works most of the time).
// Fallback: Alpha Vantage (free key via ALPHAVANTAGE_KEY env var) when Yahoo 403s/fails.
// Both normalized to the same response shape so nothing downstream changes.

async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function fromYahoo(symbol, range, interval) {
  const suffixes = ['', '.NS', '.BO'];
  const trySymbols = symbol.includes('.') ? [symbol] : suffixes.map(s => symbol.toUpperCase() + s);
  for (const sym of trySymbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`;
      const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 6000);
      if (!response.ok) continue;
      const data = await response.json();
      const result = data?.chart?.result?.[0];
      if (!result || !result.timestamp) continue;
      const meta = result.meta;
      const quotes = result.indicators?.quote?.[0];
      return {
        source: 'yahoo',
        symbol: meta.symbol, currency: meta.currency, exchange: meta.exchangeName,
        name: meta.shortName || meta.longName || sym,
        price: meta.regularMarketPrice, previousClose: meta.previousClose,
        change: +(meta.regularMarketPrice - meta.previousClose).toFixed(2),
        changePercent: +(((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100).toFixed(2),
        dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh, fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        chart: {
          timestamps: result.timestamp.map(t => t * 1000),
          close: quotes?.close || [], volume: quotes?.volume || [],
          high: quotes?.high || [], low: quotes?.low || []
        }
      };
    } catch (e) { continue; }
  }
  return null;
}

async function fromAlphaVantage(symbol, apiKey) {
  if (!apiKey) return null;
  const base = symbol.toUpperCase().replace(/\.(NS|BO|BSE)$/, '');
  const trySymbols = symbol.includes('.') ? [symbol.toUpperCase()] : [`${base}.BSE`, base];
  for (const sym of trySymbols) {
    try {
      const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(sym)}&outputsize=full&apikey=${apiKey}`;
      const r = await fetchWithTimeout(url, {}, 8000);
      if (!r.ok) continue;
      const d = await r.json();
      const series = d?.['Time Series (Daily)'];
      if (!series || typeof series !== 'object') continue;
      const dates = Object.keys(series).sort();
      if (dates.length < 40) continue;
      const recent = dates.slice(-260);
      const close = recent.map(dt => parseFloat(series[dt]['4. close']));
      const high = recent.map(dt => parseFloat(series[dt]['2. high']));
      const low = recent.map(dt => parseFloat(series[dt]['3. low']));
      const volume = recent.map(dt => parseFloat(series[dt]['5. volume']));
      const timestamps = recent.map(dt => new Date(dt).getTime());
      const lastClose = close[close.length - 1];
      const prevClose = close.length > 1 ? close[close.length - 2] : lastClose;
      return {
        source: 'alphavantage',
        symbol: sym, currency: 'INR', exchange: 'NSE/BSE', name: sym,
        price: lastClose, previousClose: prevClose,
        change: +(lastClose - prevClose).toFixed(2),
        changePercent: prevClose ? +(((lastClose - prevClose) / prevClose) * 100).toFixed(2) : 0,
        dayHigh: high[high.length - 1], dayLow: low[low.length - 1],
        fiftyTwoWeekHigh: Math.max(...high), fiftyTwoWeekLow: Math.min(...low),
        chart: { timestamps, close, volume, high, low }
      };
    } catch (e) { continue; }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { symbol, range = '3mo', interval = '1d' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  let data = await fromYahoo(symbol, range, interval);
  if (!data) data = await fromAlphaVantage(symbol, process.env.ALPHAVANTAGE_KEY);

  if (!data) {
    return res.status(404).json({ error: `Could not find stock data for ${symbol}`, triedFallback: !!process.env.ALPHAVANTAGE_KEY });
  }
  return res.status(200).json(data);
}
