// Capture the real OPENING price for today's pick(s).
// Runs at ~9:20 AM IST (5 min after NSE opens at 9:15) — by then Yahoo's
// regularMarketOpen holds the true opening print, which does NOT drift for the session.
// This is what makes the "buy at the open" logic accurate: the 9 AM pick cron selects
// the stock pre-open, and this locks the genuine opening price as the entry.

import { requireCronAuth } from './_cron-auth.js';

const REPO = 'pranaykushnaji/stock-advisor-ai';

async function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const SYMBOL_MAP = {
  'DMART': 'DMART.NS', 'ASIANPAINT': 'ASIANPAINT.NS', 'ULTRACEMCO': 'ULTRACEMCO.NS'
};

async function fetchOpen(ticker, fullName, knownSymbol) {
  const upper = (ticker || '').toUpperCase();
  const mapped = SYMBOL_MAP[upper];
  const clean = upper.replace(/[^A-Z0-9.&]/g, '');
  const trySymbols = [...new Set([knownSymbol, mapped, clean.includes('.') ? clean : clean + '.NS', clean + '.BO', clean].filter(Boolean))];
  let lastReason = 'no-symbols';
  // Two passes: Yahoo occasionally returns empty/rate-limited on a single try
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const sym of trySymbols) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
        const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 6000);
        if (!r.ok) { lastReason = `http-${r.status}`; continue; }
        const d = await r.json();
        const meta = d?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          return {
            open: meta.regularMarketOpen ? +meta.regularMarketOpen.toFixed(2) : null,
            price: +meta.regularMarketPrice.toFixed(2),
            prevClose: (meta.chartPreviousClose ?? meta.previousClose) ? +(meta.chartPreviousClose ?? meta.previousClose).toFixed(2) : null,
            symbol: meta.symbol,
            marketState: meta.marketState || null
          };
        }
        lastReason = 'no-price-in-response';
      } catch (e) { lastReason = e.name === 'AbortError' ? 'timeout' : 'fetch-error'; continue; }
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 800)); // brief backoff before retry
  }
  return { error: lastReason };
}

async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  if (!r.ok) return { content: null, sha: null, status: r.status };
  const j = await r.json();
  return { content: Buffer.from(j.content, 'base64').toString('utf-8'), sha: j.sha, status: 200 };
}

async function ghPutFile(path, contentObj, sha, token, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64'),
    ...(sha ? { sha } : {})
  };
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

export default async function handler(req, res) {
  if (!requireCronAuth(req, res)) return;

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const bq = await ghGetFile('data/project-bouquet.json', ghToken);
  let bouquet = [];
  try { bouquet = JSON.parse(bq.content)?.bouquet || []; } catch (e) {}
  if (!bouquet.length) return res.status(200).json({ status: 'empty' });

  // Only finalize entries still awaiting their real open
  const pending = bouquet.filter(b => b.entryPriceProvisional);
  if (!pending.length) return res.status(200).json({ status: 'nothing_pending', total: bouquet.length });

  const locked = [];
  const stillWaiting = [];
  for (const item of pending) {
    const pd = await fetchOpen(item.ticker, item.fullName, item.yahooSymbol);
    const isLive = pd && !pd.error && (pd.marketState === 'REGULAR' || pd.marketState === 'POST' || pd.marketState === 'CLOSED');
    if (isLive && pd.open) {
      item.entryPrice = pd.open;
      item.dayOpen = pd.open;
      item.entryPriceProvisional = false;
      item.currentPrice = pd.price;
      item.prevClose = pd.prevClose;
      item.yahooSymbol = pd.symbol;
      item.marketState = pd.marketState;
      const invested = item.investedAmount || 10000;
      item.shares = +(invested / pd.open).toFixed(3);
      item.todayChangePct = pd.prevClose ? +(((pd.price - pd.prevClose) / pd.prevClose) * 100).toFixed(2) : null;
      item.lastPriceUpdate = new Date().toISOString();
      locked.push({ ticker: item.ticker, open: pd.open, marketState: pd.marketState });
    } else {
      // Distinguish: market not open on Yahoo's feed yet (pre-market) vs an actual fetch failure
      let reason;
      if (pd?.error) reason = pd.error;                                  // timeout/http-xxx/no-price
      else if (pd?.marketState) reason = `market-${pd.marketState}`;      // e.g. market-PRE, market-PREPRE
      else reason = 'no-data';
      stillWaiting.push({ ticker: item.ticker, reason, marketState: pd?.marketState ?? null, open: pd?.open ?? null });
    }
  }

  if (locked.length) {
    await ghPutFile('data/project-bouquet.json', { bouquet }, bq.sha, ghToken, `Lock opening price for ${locked.map(l => l.ticker).join(', ')}`);
  }
  return res.status(200).json({ status: 'done', locked, stillWaiting });
}
