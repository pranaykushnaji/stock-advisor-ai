// api/news-test.js
// Diagnostic: check what each news source returns for a given NSE stock.
// Usage: /api/news-test?ticker=RELIANCE&company=Reliance%20Industries
// Lets you see real Finnhub/NewsData/Google coverage before wiring news into
// the buy/sell engines. Shows which sources returned data and the merged sentiment.

import { fetchNews } from './_news.js';

export default async function handler(req, res) {
  const ticker = (req.query.ticker || '').replace(/\.(NS|BO)$/i, '').toUpperCase();
  const company = req.query.company || ticker;
  if (!ticker) return res.status(400).json({ error: 'provide ?ticker=SYMBOL[&company=Full Name]' });

  const keys = { finnhubKey: process.env.FINNHUB_KEY, newsdataKey: process.env.NEWSDATA_KEY };
  const keyStatus = {
    finnhub: keys.finnhubKey ? 'configured' : 'MISSING (add FINNHUB_KEY in Vercel)',
    newsdata: keys.newsdataKey ? 'configured' : 'MISSING (add NEWSDATA_KEY in Vercel)',
  };

  const t0 = Date.now();
  const news = await fetchNews(company, ticker, keys);
  const ms = Date.now() - t0;

  return res.status(200).json({
    ticker, company,
    keyStatus,
    result: news,
    tookMs: ms,
    interpretation: {
      finnhubHadData: news.sources.finnhub,
      newsdataHadData: news.sources.newsdata,
      fellBackToGoogle: news.sources.google,
      note: news.count === 0
        ? 'No source returned news for this ticker — coverage gap or keys missing.'
        : `Merged ${news.count} headlines; sentiment ${news.sentiment} (${news.label}). CHECK: are these headlines actually about ${ticker}? If they are generic business news, the signal is not stock-specific.`,
    },
  });
}
