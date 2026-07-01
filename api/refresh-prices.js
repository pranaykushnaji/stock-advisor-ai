// Refreshes current prices for all project-bouquet stocks.
// Runs daily via cron; updates currentPrice so returns reflect real market moves.

const REPO = 'pranaykushnaji/stock-advisor-ai';

async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  if (!r.ok) return { content: null, sha: null };
  const d = await r.json();
  return { content: Buffer.from(d.content, 'base64').toString('utf-8'), sha: d.sha };
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

// Map company names / tickers to Yahoo NSE symbols
const SYMBOL_MAP = {
  'RELIANCE INDUSTRIES':'RELIANCE.NS','TCS':'TCS.NS','HDFC BANK':'HDFCBANK.NS',
  'INFOSYS':'INFY.NS','ICICI BANK':'ICICIBANK.NS','BHARTI AIRTEL':'BHARTIARTL.NS',
  'LARSEN & TOUBRO':'LT.NS','STATE BANK OF INDIA':'SBIN.NS','AXIS BANK':'AXISBANK.NS',
  'KOTAK MAHINDRA BANK':'KOTAKBANK.NS','HINDUSTAN UNILEVER':'HINDUNILVR.NS','ITC':'ITC.NS',
  'BAJAJ FINANCE':'BAJFINANCE.NS','MARUTI SUZUKI':'MARUTI.NS','SUN PHARMA':'SUNPHARMA.NS',
  'TATA MOTORS':'TATAMOTORS.NS','NTPC':'NTPC.NS','POWER GRID':'POWERGRID.NS',
  'ULTRATECH CEMENT':'ULTRACEMCO.NS','ASIAN PAINTS':'ASIANPAINT.NS','TITAN':'TITAN.NS',
  'WIPRO':'WIPRO.NS','ADANI PORTS':'ADANIPORTS.NS','COAL INDIA':'COALINDIA.NS',
  'JSW STEEL':'JSWSTEEL.NS','TATA STEEL':'TATASTEEL.NS','MAHINDRA & MAHINDRA':'M&M.NS',
  'NESTLE INDIA':'NESTLEIND.NS','BAJAJ AUTO':'BAJAJ-AUTO.NS','HINDALCO':'HINDALCO.NS',
  'ZOMATO':'ZOMATO.NS','DMART':'DMART.NS','AVENUE SUPERMARTS':'DMART.NS'
};

async function fetchPrice(ticker, fullName, knownSymbol) {
  const upper = (ticker || '').toUpperCase();
  const nameUpper = (fullName || '').toUpperCase().replace(/ LTD\.?| LIMITED/g, '').trim();
  const mapped = SYMBOL_MAP[upper] || SYMBOL_MAP[nameUpper];
  const clean = upper.replace(/[^A-Z0-9.&]/g, '');
  const trySymbols = [
    knownSymbol,
    mapped,
    clean.includes('.') ? clean : clean + '.NS',
    clean + '.BO',
    clean
  ].filter(Boolean);
  for (const sym of trySymbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) return { price: +meta.regularMarketPrice.toFixed(2), symbol: meta.symbol };
    } catch (e) { continue; }
  }
  return null;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isManual = cronSecret && req.query.key === cronSecret;
  if (cronSecret && !isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const bq = await ghGetFile('data/project-bouquet.json', ghToken);
  let bouquet = [];
  try { bouquet = JSON.parse(bq.content)?.bouquet || []; } catch (e) {}
  if (!bouquet.length) return res.status(200).json({ status: 'empty' });

  const now = new Date().toISOString();
  let updated = 0;
  const debug = [];
  for (const item of bouquet) {
    const pd = await fetchPrice(item.ticker, item.fullName, item.yahooSymbol);
    if (pd?.price) {
      if (!item.entryPrice) item.entryPrice = pd.price; // backfill entry if missing
      item.currentPrice = pd.price;
      item.yahooSymbol = pd.symbol;
      item.lastPriceUpdate = now;
      updated++;
      debug.push({ ticker: item.ticker, resolved: pd.symbol, entry: item.entryPrice, current: pd.price });
    } else {
      debug.push({ ticker: item.ticker, resolved: null, error: 'price fetch failed' });
    }
  }

  await ghPutFile('data/project-bouquet.json', { bouquet }, bq.sha, ghToken, `Refresh prices (${updated} stocks)`);
  return res.status(200).json({ status: 'refreshed', updated, total: bouquet.length, debug });
}
