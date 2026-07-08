// api/sell-check.js
// LIGHTWEIGHT hourly sell check — intended to be called ~hourly by GitHub Actions.
// Unlike the two-phase daily flow, this books exits IMMEDIATELY at the current price
// when a downside/exit signal fires — the whole point of hourly checks is fast exits
// for the momentum swing strategy (don't wait until 5:30 to cut a loser).
//
// Idempotent: safe to run many times a day. If nothing triggers, it writes nothing.

import { marketStatus } from './_market-calendar.js';
import { rulesGate, llmDecide, bookExit, isSuspiciousMove } from './_sell-engine.js';

const REPO = 'pranaykushnaji/stock-advisor-ai';

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const ALIASES = { ZOMATO: 'ETERNAL', MOTHERSUMI: 'MOTHERSON', MINDTREE: 'LTIM' };
function aliasBase(sym) {
  const u = (sym || '').replace(/\.(NS|BO)$/i, '').toUpperCase();
  return ALIASES[u] || u;
}

async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  if (!r.ok) return { content: null, sha: null, status: r.status };
  const d = await r.json();
  return { content: Buffer.from(d.content, 'base64').toString('utf-8'), sha: d.sha, status: 200 };
}
async function ghPutFile(path, contentObj, sha, token, message) {
  const body = { message, content: Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64'), ...(sha ? { sha } : {}) };
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

// Read-modify-write with retry: re-reads the file (fresh sha) and re-applies the change on
// each attempt, so a concurrent write by another cron (pick / refresh / another sell-check)
// can't silently clobber ours with a stale-sha 409. buildObj returns null to signal "no
// write needed". Returns true only if the write actually landed.
async function ghPutWithRetry(path, buildObj, token, message, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const cur = await ghGetFile(path, token);
    let existing = null;
    try { existing = cur.content ? JSON.parse(cur.content) : null; } catch (e) {}
    const obj = buildObj(existing);
    if (obj === null) return true; // nothing to write
    if (await ghPutFile(path, obj, cur.sha, token, message)) return true;
  }
  return false;
}

// Fetch live price + recent closes (Yahoo NSE-first, no heavy fallback to stay fast).
async function fetchLive(ticker, yahooSymbol) {
  const base = aliasBase(yahooSymbol || ticker);
  for (const sym of [`${base}.NS`, `${base}.BO`]) {
    try {
      const r = await fetchWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }, 7000);
      if (!r.ok) continue;
      const result = (await r.json())?.chart?.result?.[0];
      if (!result?.meta?.regularMarketPrice) continue;
      const meta = result.meta;
      if (meta.currency && meta.currency !== 'INR') continue;
      return {
        price: +meta.regularMarketPrice.toFixed(2),
        marketState: meta.marketState || null,
        closes: (result.indicators?.quote?.[0]?.close || []).filter(v => v != null && !isNaN(v)),
      };
    } catch (e) { continue; }
  }
  return null;
}

export default async function handler(req, res) {
  // Auth — same CRON_SECRET pattern as the other crons.
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  const provided = auth.replace(/^Bearer\s+/i, '') || req.query.key;
  const isAuthed = !cronSecret || provided === cronSecret;
  if (!isAuthed) return res.status(401).json({ error: 'Unauthorized' });

  // Only act during/after market hours on trading days (unless forced).
  const mkt = marketStatus();
  if (!mkt.open && req.query.force !== 'true') {
    return res.status(200).json({ status: 'skipped', reason: mkt.reason });
  }

  const ghToken = process.env.GITHUB_TOKEN;
  const apiKey = process.env.GROQ_API_KEY;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN missing' });

  const bq = await ghGetFile('data/project-bouquet.json', ghToken);
  if (!bq.content) return res.status(200).json({ status: 'no_bouquet' });
  let bouquet;
  try { bouquet = JSON.parse(bq.content).bouquet || []; } catch (e) { return res.status(500).json({ error: 'bad bouquet json' }); }

  const open = bouquet.filter(b => !b.status || b.status === 'OPEN');
  if (!open.length) return res.status(200).json({ status: 'no_open_positions' });

  const closedTrades = [];
  const checked = [];

  for (const item of open) {
    const live = await fetchLive(item.ticker, item.yahooSymbol);
    if (!live) { checked.push({ ticker: item.ticker, result: 'no_price' }); continue; }
    // Freshen current price + peak (for the trailing stop) for the rules gate.
    item.currentPrice = live.price;
    item.peakPrice = Math.max(item.peakPrice ?? item.entryPrice ?? live.price, live.price);

    // Rules gate first (target/stop/max-hold/momentum-fade), then LLM for the ambiguous middle.
    let decision = rulesGate(item, live.closes);
    if (!decision) {
      // Ask the LLM regardless of whether the position is up or down — a winning position can
      // have its thesis reverse (earnings miss, bad news) just as easily as a losing one, and
      // only checking losers means that deterioration goes undetected until it becomes a loss.
      const pnl = item.entryPrice ? ((live.price - item.entryPrice) / item.entryPrice) * 100 : 0;
      const heldDays = item.date ? Math.floor((Date.now() - new Date(item.date + 'T00:00:00Z').getTime()) / 86400000) : 0;
      // Skip the LLM (and any exit) on an implausibly large move for a fresh position — it's
      // almost certainly a bad price, not a real signal. Never book a phantom loss on it.
      if (!isSuspiciousMove(pnl, heldDays) && apiKey) {
        const d = await llmDecide(item, apiKey, []);
        if (d.verdict === 'SELL') decision = d;
      }
    }

    if (decision) {
      // Book the exit IMMEDIATELY at the live price (fast momentum exit).
      const closed = bookExit({ ...item, exitReason: decision.reason, exitSource: decision.source }, live.price);
      closedTrades.push(closed);
      checked.push({ ticker: item.ticker, result: 'SOLD', reason: decision.reason, price: live.price });
    } else {
      checked.push({ ticker: item.ticker, result: 'hold', price: live.price });
    }
  }

  if (!closedTrades.length) {
    return res.status(200).json({ status: 'checked', sold: 0, positions: checked });
  }

  // Persist (concurrency-safe): append to the realized ledger, then remove sold from the
  // bouquet. Both writes re-read + retry on conflict so an overlapping cron can't clobber
  // them. A position is keyed by ticker+entryDate so it can be booked AT MOST ONCE, even if
  // two runs overlap or one retries — this is what prevents double-booked (phantom) P&L.
  const tradeKey = t => `${t.ticker}|${t.entryDate}`;
  const soldKeys = new Set(closedTrades.map(tradeKey));

  const realizedOk = await ghPutWithRetry('data/realized.json', (existing) => {
    const ledger = existing && Array.isArray(existing.trades) ? existing : { trades: [] };
    const seen = new Set(ledger.trades.map(tradeKey));
    const toAdd = closedTrades.filter(t => !seen.has(tradeKey(t)));
    if (!toAdd.length) return null; // already booked by a concurrent run — no write
    ledger.trades.push(...toAdd);
    return ledger;
  }, ghToken, `Hourly sell-check: book ${closedTrades.length} exit(s)`);

  const bouquetOk = await ghPutWithRetry('data/project-bouquet.json', (existing) => {
    const list = existing?.bouquet || [];
    // Drop only the positions we just sold that are still OPEN in the freshest bouquet.
    const remaining = list.filter(b => !(soldKeys.has(`${b.ticker}|${b.date}`) && (!b.status || b.status === 'OPEN')));
    if (remaining.length === list.length) return null; // nothing to remove — no write
    return { bouquet: remaining };
  }, ghToken, `Hourly sell-check: close ${closedTrades.length} position(s)`);

  return res.status(200).json({ status: 'checked', sold: closedTrades.length, realizedOk, bouquetOk, closed: closedTrades.map(c => ({ ticker: c.ticker, pnlPct: c.realizedPnlPct, reason: c.exitReason })), positions: checked });
}
