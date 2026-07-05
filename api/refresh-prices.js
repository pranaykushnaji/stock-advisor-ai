// Refreshes current prices for all project-bouquet stocks.
// Runs daily via cron; updates currentPrice so returns reflect real market moves.

import { marketStatus } from './_market-calendar.js';
import { bookExit } from './_sell-engine.js';

const REPO = 'pranaykushnaji/stock-advisor-ai';

async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  if (!r.ok) return { content: null, sha: null, status: r.status, statusText: r.statusText };
  const d = await r.json();
  return { content: Buffer.from(d.content, 'base64').toString('utf-8'), sha: d.sha, status: 200 };
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
  'ZOMATO':'ETERNAL.NS','ETERNAL':'ETERNAL.NS','DMART':'DMART.NS','AVENUE SUPERMARTS':'DMART.NS'
};

// Ticker aliases for rebrands (LLM/stored ticker may be stale). Applied to AV fallback too.
const TICKER_ALIASES = { 'ZOMATO':'ETERNAL','MINDTREE':'LTIM','MOTHERSUMI':'MOTHERSON' };
function aliasBase(sym){const u=(sym||'').toUpperCase().replace(/\.(NS|BO|BSE)$/,'');return TICKER_ALIASES[u]||u;}

// Fetch with a hard timeout so a hanging source can't blow the serverless limit
async function fetchWithTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

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
      const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 4000);
      if (!r.ok) continue;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      const meta = result?.meta;
      if (meta?.regularMarketPrice) {
        // Prefer INR (NSE/BSE); skip USD ADR unless last symbol
        const isLast = sym === trySymbols[trySymbols.length - 1];
        if (meta.currency && meta.currency !== 'INR' && !isLast) continue;
        // Today's daily candle (last bar) — has the real session open & close
        const q = result?.indicators?.quote?.[0] || {};
        const opens = (q.open || []).filter(v => v != null);
        const closes = (q.close || []).filter(v => v != null);
        const candleOpen = opens.length ? +opens[opens.length - 1].toFixed(2) : null;
        const candleClose = closes.length ? +closes[closes.length - 1].toFixed(2) : null;
        return {
          price: +meta.regularMarketPrice.toFixed(2),
          open: meta.regularMarketOpen ? +meta.regularMarketOpen.toFixed(2) : null,
          candleOpen,   // today's real opening price from the completed daily bar
          candleClose,  // today's real closing price from the completed daily bar
          prevClose: (meta.chartPreviousClose ?? meta.previousClose) ? +(meta.chartPreviousClose ?? meta.previousClose).toFixed(2) : null,
          symbol: meta.symbol,
          marketState: meta.marketState || null  // PRE/PREPRE, REGULAR, POST, CLOSED
        };
      }
    } catch (e) { continue; }
  }
  // Fallback: Alpha Vantage when Yahoo fails (apply rebrand alias)
  return await fetchPriceAV(aliasBase(clean));
}

// Alpha Vantage fallback for refresh — daily OHLC, last bar = today's candle
async function fetchPriceAV(base) {
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if (!apiKey) return null;
  for (const sym of [`${base}.BSE`, base]) {
    try {
      const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(sym)}&outputsize=compact&apikey=${apiKey}`;
      const r = await fetchWithTimeout(url, {}, 8000);
      if (!r.ok) continue;
      const d = await r.json();
      const series = d?.['Time Series (Daily)'];
      if (!series || typeof series !== 'object') continue;
      const dates = Object.keys(series).sort();
      if (!dates.length) continue;
      const lastDt = dates[dates.length - 1], prevDt = dates[dates.length - 2];
      const bar = series[lastDt];
      const close = parseFloat(bar['4. close']);
      const open = parseFloat(bar['1. open']);
      const prevClose = prevDt ? parseFloat(series[prevDt]['4. close']) : close;
      return {
        price: +close.toFixed(2), open: +open.toFixed(2),
        candleOpen: +open.toFixed(2), candleClose: +close.toFixed(2),
        prevClose: +prevClose.toFixed(2), symbol: sym,
        marketState: 'CLOSED'  // AV daily is end-of-day data
      };
    } catch (e) { continue; }
  }
  return null;
}

// Today's date in IST (YYYY-MM-DD) — matches the pick cron's date field
function todayISO() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

// Is NSE currently in a live/complete trading state? (REGULAR = open, POST/CLOSED = has real close)
// PRE/PREPRE = pre-market: prices are stale/indicative, do NOT trust as live.
// Only PRE/PREPRE (pre-market) prices are stale/indicative and must be skipped.
// Everything else — REGULAR, POST, CLOSED, or an unknown/null state — is treated as
// usable. (The old allowlist failed closed on any unexpected value, wrongly skipping
// valid post-close data, e.g. a 5:30 PM refresh finding marketState it didn't recognize.)
function isTradingDataReliable(marketState) {
  const s = (marketState || '').toUpperCase();
  return s !== 'PRE' && s !== 'PREPRE';
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isManual = cronSecret && req.query.key === cronSecret;
  if (cronSecret && !isCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  // Skip on weekends / NSE holidays. Manual calls with ?force=true bypass (for testing).
  const mkt = marketStatus();
  if (!mkt.open && req.query.force !== 'true') {
    console.log(`[market-guard] refresh skipped — market closed (${mkt.reason})`);
    return res.status(200).json({ status: 'skipped', reason: mkt.reason });
  }

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured', hint: 'Add GITHUB_TOKEN in Vercel → Settings → Environment Variables, then redeploy' });

  const bq = await ghGetFile('data/project-bouquet.json', ghToken);
  let bouquet = [];
  try { bouquet = JSON.parse(bq.content)?.bouquet || []; } catch (e) {}
  if (!bouquet.length) {
    return res.status(200).json({ status: 'empty', reason: bq.status === 401 ? 'github token invalid' : bq.content == null ? 'bouquet file not found' : 'bouquet empty' });
  }

  const now = new Date().toISOString();
  let updated = 0;
  const failed = [];

  // Fetch the Nifty 50 level for benchmark/alpha tracking
  let niftyNow = null;
  try {
    const nr = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 4000);
    if (nr.ok) {
      const nd = await nr.json();
      const nm = nd?.chart?.result?.[0]?.meta;
      if (nm?.regularMarketPrice) niftyNow = +nm.regularMarketPrice.toFixed(2);
    }
  } catch (e) {}

  // Process in parallel batches so a large bouquet doesn't run sequentially past the time limit
  const BATCH = 8;
  let skippedPremarket = 0;
  for (let i = 0; i < bouquet.length; i += BATCH) {
    const slice = bouquet.slice(i, i + BATCH);
    await Promise.all(slice.map(async (item) => {
      const pd = await fetchPrice(item.ticker, item.fullName, item.yahooSymbol);
      if (pd?.price) {
        const reliable = isTradingDataReliable(pd.marketState);
        // Always safe to refresh reference data (prevClose) and the resolved symbol
        item.prevClose = pd.prevClose;
        item.yahooSymbol = pd.symbol;
        // UPGRADE entry to today's real OPEN once the daily candle is complete.
        // The 9 AM cron locked entry = prevClose (never empty); here we improve it to the
        // true session open when available. Guarded so it only happens on the pick's own day
        // and only once (clears the flag). Falls back silently if the candle open isn't there.
        if (item.entryFromPrevClose && reliable && pd.candleOpen && item.date === todayISO()) {
          item.entryPrice = pd.candleOpen;
          item.dayOpen = pd.candleOpen;
          item.entryFromPrevClose = false;
          item.entryPriceProvisional = false;
        }
        // Backfill: any entry still missing entirely
        if ((!item.entryPrice || item.entryPriceProvisional) && reliable && pd.open) {
          item.entryPrice = pd.open;
          item.entryPriceProvisional = false;
          item.dayOpen = pd.open;
        }
        // Only update the LIVE price + today's move when the data is actually live/complete.
        // Pre-market (PRE/PREPRE) prices are stale or indicative — skip them to avoid bogus moves.
        if (reliable) {
          // Prefer the completed candle close for "current" after market close; else live price
          item.currentPrice = pd.candleClose || pd.price;
          // For a SELL_PENDING position, this fresh price is the real exit to book at 5:30.
          if (item.status === 'SELL_PENDING') item._realExit = pd.candleClose || pd.price;
          item.lastPriceUpdate = now;
          const invested = item.investedAmount || 10000;
          if (item.entryPrice > 0) item.shares = +(invested / item.entryPrice).toFixed(3);
          item.todayChangePct = pd.prevClose ? +((((pd.candleClose || pd.price) - pd.prevClose) / pd.prevClose) * 100).toFixed(2) : null;
          item.marketState = pd.marketState;
          if (niftyNow != null && item.niftyAtEntry == null) item.niftyAtEntry = niftyNow;
          if (niftyNow != null) item.niftyNow = niftyNow;
          updated++;
        } else {
          skippedPremarket++;
        }
      } else {
        failed.push(item.ticker);
      }
    }));
  }

  // ---- PHASE 2: finalize SELL_PENDING positions ----
  // Book the real exit (fresh price captured above; fall back to provisional if the
  // fetch failed), append to data/realized.json, and remove from the bouquet.
  // A pending position with no fresh price stays pending and retries next cycle.
  const closedTrades = [];
  const remaining = [];
  for (const item of bouquet) {
    if (item.status === 'SELL_PENDING' && (item._realExit != null || item.provisionalExitPrice != null)) {
      closedTrades.push(bookExit(item, item._realExit));
    } else {
      delete item._realExit; // never persist the scratch field
      remaining.push(item);
    }
  }

  let realizedWritten = 0;
  if (closedTrades.length) {
    // Append to the realized ledger (retry-safe: re-read, append, write).
    for (let attempt = 0; attempt < 2; attempt++) {
      const rl = await ghGetFile('data/realized.json', ghToken);
      let ledger = { trades: [] };
      try { if (rl.content) ledger = JSON.parse(rl.content); } catch (e) {}
      if (!Array.isArray(ledger.trades)) ledger.trades = [];
      ledger.trades.push(...closedTrades);
      const ok = await ghPutFile('data/realized.json', ledger, rl.sha, ghToken, `Book ${closedTrades.length} realized sell(s)`);
      if (ok) { realizedWritten = closedTrades.length; break; }
    }
  }

  // Write the bouquet if prices changed OR positions were closed out.
  if (updated > 0 || closedTrades.length) {
    const finalBouquet = closedTrades.length ? remaining : bouquet;
    finalBouquet.forEach(it => delete it._realExit);
    await ghPutFile('data/project-bouquet.json', { bouquet: finalBouquet }, bq.sha, ghToken,
      closedTrades.length ? `Refresh prices + close ${closedTrades.length} position(s)` : `Refresh prices (${updated} stocks)`);
  }
  const out = { status: 'refreshed', updated, total: bouquet.length, nifty: niftyNow };
  if (skippedPremarket) out.skippedPremarket = skippedPremarket;
  if (failed.length) out.failed = failed;
  if (realizedWritten) out.closed = realizedWritten;
  return res.status(200).json(out);
}
