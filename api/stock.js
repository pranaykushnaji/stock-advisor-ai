export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { symbol, range = '3mo', interval = '1d' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Try NSE first, then BSE, then raw symbol (for US stocks)
  const suffixes = ['', '.NS', '.BO'];
  // If symbol already has a dot (like AAPL), just use it directly
  const trySymbols = symbol.includes('.') ? [symbol] : suffixes.map(s => symbol.toUpperCase() + s);

  for (const sym of trySymbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}&includePrePost=false`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });

      if (!response.ok) continue;

      const data = await response.json();
      const result = data?.chart?.result?.[0];
      if (!result || !result.timestamp) continue;

      const meta = result.meta;
      const quotes = result.indicators?.quote?.[0];

      return res.status(200).json({
        symbol: meta.symbol,
        currency: meta.currency,
        exchange: meta.exchangeName,
        name: meta.shortName || meta.longName || sym,
        price: meta.regularMarketPrice,
        previousClose: meta.previousClose,
        change: +(meta.regularMarketPrice - meta.previousClose).toFixed(2),
        changePercent: +(((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100).toFixed(2),
        dayHigh: meta.regularMarketDayHigh,
        dayLow: meta.regularMarketDayLow,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        chart: {
          timestamps: result.timestamp.map(t => t * 1000),
          close: quotes?.close || [],
          volume: quotes?.volume || [],
          high: quotes?.high || [],
          low: quotes?.low || []
        }
      });
    } catch (e) {
      continue;
    }
  }

  return res.status(404).json({ error: `Could not find stock data for ${symbol}` });
}
