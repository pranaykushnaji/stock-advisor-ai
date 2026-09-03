// Refreshes current prices for all project-portfolio stocks after the market closes.
// Also completes any legacy SELL_PENDING rows left by an older deployment.

import { marketStatus } from './_market-calendar.js';
import { bookExit } from './_sell-engine.js';
import { observePrice, mergeRiskState } from './_position-risk.js';
import { requireCronAuth } from './_cron-auth.js';

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

// Read-modify-write with retry: re-reads the file (fresh sha) and re-applies the change on
// each attempt, so an overlapping cron (pick / sell-check / another refresh) can't silently
// clobber this write with a stale-sha 409. buildObj returns null for "no write needed".
async function ghPutWithRetry(path, buildObj, token, message, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const cur = await ghGetFile(path, token);
    let existing = null;
    try { existing = cur.content ? JSON.parse(cur.content) : null; } catch (e) {}
    const obj = buildObj(existing);
    if (obj === null) return true;
    if (await ghPutFile(path, obj, cur.sha, token, message)) return true;
  }
  return false;
}

// Only these fields are owned/updated by the price-refresh cron. On a conflicting write we
// overlay just these onto the freshest bouquet row, so a concurrent status/structure change
// (a new pick, a SELL_PENDING flip, a sell-check removal) is preserved rather than clobbered.
const REFRESH_PRICE_FIELDS = [
  'prevClose', 'yahooSymbol', 'entryPrice', 'dayOpen', 'entryFromPrevClose',
  'entryPriceProvisional', 'currentPrice', 'peakPrice', 'lastPriceUpdate', 'shares',
  'todayChangePct', 'marketState', 'niftyAtEntry', 'niftyNow',
];

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
        const highs = (q.high || []).filter(v => v != null);
        const candleOpen = opens.length ? +opens[opens.length - 1].toFixed(2) : null;
        const candleClose = closes.length ? +closes[closes.length - 1].toFixed(2) : null;
        const dayHigh = highs.length ? +highs[highs.length - 1].toFixed(2) : null;
        return {
          price: +meta.regularMarketPrice.toFixed(2),
          open: meta.regularMarketOpen ? +meta.regularMarketOpen.toFixed(2) : null,
          candleOpen,   // today's real opening price from the completed daily bar
          candleClose,  // today's real closing price from the completed daily bar
          dayHigh,
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
      const high = parseFloat(bar['2. high']);
      const prevClose = prevDt ? parseFloat(series[prevDt]['4. close']) : close;
      return {
        price: +close.toFixed(2), open: +open.toFixed(2),
        candleOpen: +open.toFixed(2), candleClose: +close.toFixed(2), dayHigh: Number.isFinite(high) ? +high.toFixed(2) : null,
        prevClose: +prevClose.toFixed(2), symbol: sym,
        marketState: 'CLOSED'  // AV daily is end-of-day data
      };
    } catch (e) { continue; }
  }
  return null;
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
  if (!requireCronAuth(req, res)) return;

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
        // NOTE: entry is locked at the actual signal-time price by stock-of-the-day.js and must
        // NEVER be overwritten with the day's open here — that would reintroduce the lookahead
        // bias (a "free" head-start on every trade) this fix removed. Only a genuinely missing
        // entry price gets backfilled below.
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
          // Track the peak since entry for the trailing stop (use the day's HIGH when available).
          // No timestamped high is available here. Only the observed quote is safe;
          // sell-check can use a dated daily high on sessions after entry.
          observePrice(item, item.currentPrice, { observedAt: now });
          // Backward compatibility: finalize any legacy SELL_PENDING position at this price.
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

  // ---- Legacy compatibility: finalize SELL_PENDING positions ----
  // Book the real exit (fresh price captured above; fall back to provisional if the
  // fetch failed), append to data/realized.json, and remove from the bouquet.
  // A pending position with no fresh price stays pending and retries next cycle.
  const closedTrades = [];
  for (const item of bouquet) {
    if (item.status === 'SELL_PENDING' && (item._realExit != null || item.provisionalExitPrice != null)) {
      closedTrades.push(bookExit(item, item._realExit));
    }
  }

  // A position (ticker + entry date) is realized AT MOST ONCE — this dedupe is what stops
  // a phantom double-booking if this run overlaps/retries against sell-check or another refresh.
  const tradeKey = t => `${t.ticker}|${t.entryDate}`;
  const closedKeys = new Set(closedTrades.map(tradeKey));

  // Map of our computed price updates by position key, for the merge-on-conflict write below.
  const updatesByKey = new Map();
  for (const it of bouquet) {
    const k = `${it.ticker}|${it.date}`;
    if (!closedKeys.has(k)) updatesByKey.set(k, it);
  }

  let realizedWritten = 0;
  let realizedOk = true;
  if (closedTrades.length) {
    // Append to the realized ledger — retry-safe AND de-duped (idempotent).
    realizedOk = await ghPutWithRetry('data/realized.json', (existing) => {
      const ledger = existing && Array.isArray(existing.trades) ? existing : { trades: [] };
      const seen = new Set(ledger.trades.map(tradeKey));
      const toAdd = closedTrades.filter(t => !seen.has(tradeKey(t)));
      if (!toAdd.length) return null; // already booked elsewhere — no write
      ledger.trades.push(...toAdd);
      return ledger;
    }, ghToken, `Book ${closedTrades.length} realized sell(s)`);
    if (realizedOk) realizedWritten = closedTrades.length;
  }

  // A failed ledger append must not make the position disappear from the portfolio. Keep it
  // pending for the next idempotent refresh and report failure loudly to the scheduler.
  if (closedTrades.length && !realizedOk) {
    return res.status(502).json({
      status: 'exit_write_failed', updated, total: bouquet.length,
      reason: 'realized ledger write failed; pending positions retained for retry',
      pending: closedTrades.map(t => t.ticker),
    });
  }

  // Write the bouquet if prices changed OR positions were closed out. On conflict, re-read
  // the freshest bouquet and overlay ONLY our price fields per position (and drop closed
  // ones), so a concurrent add/removal/status-change by another cron is never clobbered.
  if (updated > 0 || closedTrades.length) {
    const bouquetOk = await ghPutWithRetry('data/project-bouquet.json', (existing) => {
      const fresh = existing?.bouquet || [];
      const out = [];
      for (const fb of fresh) {
        const k = `${fb.ticker}|${fb.date}`;
        if (closedKeys.has(k)) continue; // realized/closed this run — remove it
        const upd = updatesByKey.get(k);
        if (upd) {
          const merged = { ...fb };
          for (const f of REFRESH_PRICE_FIELDS) if (upd[f] !== undefined) merged[f] = upd[f];
          Object.assign(merged, mergeRiskState(fb, upd));
          delete merged._realExit;
          out.push(merged);
        } else {
          out.push(fb); // a position we didn't process (e.g. added concurrently) — leave as-is
        }
      }
      return { bouquet: out };
    }, ghToken, closedTrades.length ? `Refresh prices + close ${closedTrades.length} position(s)` : `Refresh prices (${updated} stocks)`);
    if (!bouquetOk) {
      return res.status(502).json({
        status: 'portfolio_write_failed', updated, total: bouquet.length,
        reason: closedTrades.length
          ? 'exits were booked, but portfolio cleanup will retry on the next run'
          : 'price updates could not be committed after retries',
        closed: realizedWritten,
      });
    }
  }
  const out = { status: 'refreshed', updated, total: bouquet.length, nifty: niftyNow };
  if (skippedPremarket) out.skippedPremarket = skippedPremarket;
  if (failed.length) out.failed = failed;
  if (realizedWritten) out.closed = realizedWritten;
  return res.status(200).json(out);
}
