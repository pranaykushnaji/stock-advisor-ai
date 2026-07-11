// api/sell-check.js
// LIGHTWEIGHT hourly sell check — intended to be called ~hourly by GitHub Actions.
// Unlike the two-phase daily flow, this books exits IMMEDIATELY at the current price
// when a downside/exit signal fires — the whole point of hourly checks is fast exits
// for the momentum swing strategy (don't wait until 5:30 to cut a loser).
//
// Idempotent: safe to run many times a day. If nothing triggers, it writes nothing.

import { marketStatus } from './_market-calendar.js';
import { rulesGate, llmDecide, bookExit, isSuspiciousMove } from './_sell-engine.js';
import { classifyCatalyst, scoreCatalyst } from './_catalyst.js';

const REPO = 'pranaykushnaji/stock-advisor-ai';

// V2 THESIS ENGINE — routine-filing noise never worth an LLM call (mirrors premarket.js).
const ROUTINE_RE = /certificate|loss of share|duplicate|trading window|book closure|record date|newspaper|publication|shareholders meeting|shareholder meeting|agm|egm|postal ballot|investor meet|analyst meet|esop|allotment of equity|listing obligation|regulation 74|regulation 39|spurt in volume|clarification|compliance certificate|reconciliation of share/i;
const MAX_THESIS_LLM = 3; // cap classification calls per hourly run

// NSE announcement timestamps are IST wall clock ("10-Jul-2026 15:25:44"); parse into a
// consistent frame and shift ISO (UTC) timestamps into the same frame for comparison.
const parseAnnMs = (s) => { const t = Date.parse(String(s || '').replace(/-/g, ' ')); return isFinite(t) ? t : null; };
const isoToAnnFrame = (iso) => { const t = Date.parse(iso || ''); return isFinite(t) ? t + 5.5 * 3600 * 1000 : null; };

// Update one position's thesis from filings newer than its last update. Returns
// { changed, breakSell } — breakSell is a forced-exit decision on a confident negative filing.
// Mutates item.thesisScore / currentThesis / lastThesisUpdate.
async function updateThesis(item, filings, apiKey, budget) {
  const lastMs = isoToAnnFrame(item.lastThesisUpdate || item.addedAt) ?? 0;
  const fresh = (filings || []).filter(f => { const t = parseAnnMs(f.date); return t != null && t > lastMs; });
  if (!fresh.length) return { changed: false, breakSell: null };
  item.lastThesisUpdate = new Date().toISOString();
  const material = fresh.filter(f => !ROUTINE_RE.test(f.subject || ''));
  if (!material.length || !apiKey || budget.used >= MAX_THESIS_LLM) return { changed: true, breakSell: null };
  budget.used++;
  let scored = null;
  try {
    const articles = material.map(f => ({ title: '[OFFICIAL NSE FILING] ' + f.subject, url: '', publishedAt: parseAnnMs(f.date) || Date.now(), source: 'nse-filing' }));
    scored = scoreCatalyst(await classifyCatalyst(item.fullName || item.ticker, articles, apiKey), articles);
  } catch (e) { return { changed: true, breakSell: null }; }
  if (!scored) return { changed: true, breakSell: null };
  const prev = item.thesisScore ?? 50;
  if (scored.negative) {
    // Thesis damage: order cancellations, investigations, fraud, regulatory action…
    item.thesisScore = Math.max(0, prev - 30);
    item.currentThesis = { type: scored.type, summary: scored.summary || 'negative filing', points: 0 };
    if (item.thesisScore < 35) {
      return { changed: true, breakSell: { verdict: 'SELL', source: 'thesis', reason: `thesis broken — negative filing (${scored.type})` } };
    }
  } else if (scored.points > 0) {
    // Reinforcement: follow-on orders, results beat, more verified positives.
    item.thesisScore = Math.min(100, prev + 15);
    item.currentThesis = { type: scored.type, summary: scored.summary || null, points: Math.max(item.currentThesis?.points || 0, scored.points) };
  }
  return { changed: true, breakSell: null };
}

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

  // V2 THESIS ENGINE: pull held tickers' filings from the committed snapshot (refreshed at :45
  // each hour) so each position's thesis stays current — reinforced by follow-on positives,
  // damaged by negatives, broken (forced exit) by a confident negative filing.
  const filingsBySym = new Map();
  try {
    const snapFile = await ghGetFile('data/nse-snapshot.json', ghToken);
    const sd = snapFile.content ? JSON.parse(snapFile.content)?.data : null;
    for (const a of (sd?.announcements || [])) {
      const sym = String(a.symbol || '').toUpperCase();
      if (!sym) continue;
      if (!filingsBySym.has(sym)) filingsBySym.set(sym, []);
      filingsBySym.get(sym).push({ subject: a.subject, date: a.date });
    }
  } catch (e) { /* no snapshot → thesis simply not updated this run */ }
  const thesisBudget = { used: 0 };
  const thesisChangedKeys = new Set();

  // V3 NEWS-INTEL negatives (pre-classified by the daily Claude research routine): a material
  // negative item on a HELD name damages its thesis without spending an LLM call here.
  // Freshness-gated like premarket; items older than the position's last thesis update are
  // skipped, so a damage hit applies at most once.
  let intelItems = [], intelGeneratedMs = 0;
  try {
    const f = await ghGetFile('data/news-intel.json', ghToken);
    const ni = f.content ? JSON.parse(f.content) : null;
    const ageH = ni?.generatedAt ? (Date.now() - Date.parse(ni.generatedAt)) / 3600000 : Infinity;
    if (ageH <= 20 && Array.isArray(ni.items)) { intelItems = ni.items; intelGeneratedMs = Date.parse(ni.generatedAt); }
  } catch (e) {}
  function applyIntelNegatives(item) {
    const lastMs = Date.parse(item.lastThesisUpdate || item.addedAt || '') || 0;
    const hit = intelItems.find(it => String(it.ticker || '').toUpperCase() === String(item.ticker).toUpperCase()
      && String(it.direction) === 'negative' && (it.materiality ?? 0) >= 6
      && ((it.publishedAt ? Date.parse(it.publishedAt) : intelGeneratedMs) > lastMs));
    if (!hit) return { changed: false, breakSell: null };
    item.lastThesisUpdate = new Date().toISOString();
    item.thesisScore = Math.max(0, (item.thesisScore ?? 50) - 30);
    item.currentThesis = { type: hit.eventType || 'negative news', summary: hit.summary || 'material negative news', points: 0 };
    const breakSell = item.thesisScore < 35
      ? { verdict: 'SELL', source: 'thesis', reason: `thesis broken — negative news (${hit.eventType || 'intel'})` }
      : null;
    return { changed: true, breakSell };
  }

  const closedTrades = [];
  const checked = [];

  for (const item of open) {
    const live = await fetchLive(item.ticker, item.yahooSymbol);
    if (!live) { checked.push({ ticker: item.ticker, result: 'no_price' }); continue; }
    // Freshen current price + peak (for the trailing stop) for the rules gate.
    item.currentPrice = live.price;
    item.peakPrice = Math.max(item.peakPrice ?? item.entryPrice ?? live.price, live.price);

    // Thesis update from pre-classified news intel, then from new filings (either may force
    // a thesis-break exit).
    let thesisSell = null;
    try {
      const ni = applyIntelNegatives(item);
      if (ni.changed) thesisChangedKeys.add(`${item.ticker}|${item.date}`);
      thesisSell = ni.breakSell;
      if (!thesisSell) {
        const tu = await updateThesis(item, filingsBySym.get(String(item.ticker).toUpperCase()), apiKey, thesisBudget);
        if (tu.changed) thesisChangedKeys.add(`${item.ticker}|${item.date}`);
        thesisSell = tu.breakSell;
      }
    } catch (e) {}

    // Thesis break first, then rules gate (thesis-aware trail/max-hold; stop absolute),
    // then LLM for the ambiguous middle.
    let decision = thesisSell || rulesGate(item, live.closes);
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

  // Persist thesis-field changes (merge-only overlay — never clobbers concurrent writes).
  const thesisByKey = new Map(open.map(it => [`${it.ticker}|${it.date}`, it]));
  const writeThesisUpdates = async () => {
    if (!thesisChangedKeys.size) return;
    await ghPutWithRetry('data/project-bouquet.json', (existing) => {
      const list = existing?.bouquet || [];
      let touched = false;
      for (const b of list) {
        const k = `${b.ticker}|${b.date}`;
        const src = thesisChangedKeys.has(k) ? thesisByKey.get(k) : null;
        if (src) {
          b.thesisScore = src.thesisScore ?? b.thesisScore;
          b.currentThesis = src.currentThesis ?? b.currentThesis;
          b.lastThesisUpdate = src.lastThesisUpdate ?? b.lastThesisUpdate;
          touched = true;
        }
      }
      return touched ? { bouquet: list } : null;
    }, ghToken, `Sell-check: thesis update (${thesisChangedKeys.size})`);
  };

  if (!closedTrades.length) {
    await writeThesisUpdates();
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
  await writeThesisUpdates(); // surviving positions keep their refreshed thesis

  return res.status(200).json({ status: 'checked', sold: closedTrades.length, realizedOk, bouquetOk, closed: closedTrades.map(c => ({ ticker: c.ticker, pnlPct: c.realizedPnlPct, reason: c.exitReason })), positions: checked });
}
