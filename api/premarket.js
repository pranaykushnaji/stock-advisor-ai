// api/premarket.js
// PRE-MARKET RESEARCH (~08:05 IST, after the 07:45 snapshot refresh) — the "start research
// early" half of the morning-capture system. The market's biggest single-day moves (PAYTM/
// BANDHANBNK 2026-07-10: +5-6%, mostly at/near the open) are driven by OVERNIGHT information;
// by the first 10:00 scan the good prices are gone. This endpoint does the thinking before
// the bell so the 09:25 open-scan (open-scan.js) can act in the first minutes:
//
//   1. OVERNIGHT FILINGS — announcements filed since yesterday's close, routine noise stripped,
//      the rest LLM-classified. A bullish, high-impact overnight filing = VERIFIED catalyst
//      known BEFORE the open. Also written into catalyst-memory so all day's scans see it.
//   2. WARM CARRYOVER — yesterday's intraday watchlist names that finished strong (the PAYTM
//      case: ended the day at confidence 72/inst 90 but unbought). Strong finishers often
//      continue at the next open.
//
// Output: data/premarket-watchlist.json — the ONLY names the 09:25 open-scan may buy.
// No LLM narrative here; classification only. Nothing here places trades.

import { marketStatus } from './_market-calendar.js';
import { classifyCatalyst, scoreCatalyst, rememberCatalyst } from './_catalyst.js';

const REPO = 'pranaykushnaji/stock-advisor-ai';
const MAX_LLM_CLASSIFY = 8;   // cap the 08:00 LLM budget
const MAX_WATCHLIST = 10;
const WARM_MIN_CONF = 60;     // yesterday's best confidence to qualify as a warm carryover

// Routine-filing noise: never worth an LLM call. (Mirrors the classifier's "No catalyst" set.)
const ROUTINE_RE = /certificate|loss of share|duplicate|trading window|book closure|record date|newspaper|publication|shareholders meeting|shareholder meeting|agm|egm|postal ballot|investor meet|analyst meet|esop|allotment of equity|listing obligation|regulation 74|regulation 39|regulation 30 \(loss|spurt in volume|clarification|compliance certificate|reconciliation of share/i;

async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' },
  });
  if (!r.ok) return { content: null, sha: null };
  const d = await r.json();
  return { content: Buffer.from(d.content, 'base64').toString('utf-8'), sha: d.sha };
}
async function ghPutWithRetry(path, buildObj, token, message, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const cur = await ghGetFile(path, token);
    let existing = null;
    try { existing = cur.content ? JSON.parse(cur.content) : null; } catch (e) {}
    const obj = buildObj(existing);
    if (obj === null) return true;
    const body = { message, content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64'), ...(cur.sha ? { sha: cur.sha } : {}) };
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method: 'PUT', headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.ok) return true;
  }
  return false;
}

function todayIST() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

// Parse NSE's "10-Jul-2026 15:25:44" (IST wall clock) into a comparable ms value. Both sides of
// every comparison here use this same parse, so the absolute timezone doesn't matter.
function parseAnnMs(s) {
  const t = Date.parse(String(s || '').replace(/-/g, ' '));
  return isFinite(t) ? t : null;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.key;
  if (cronSecret && provided !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });

  // Trading-day guard only — this deliberately runs pre-open, so no hours check.
  const mkt = marketStatus();
  if (!mkt.open && req.query.force !== 'true') return res.status(200).json({ status: 'skipped', reason: mkt.reason });

  const ghToken = process.env.GITHUB_TOKEN;
  const apiKey = process.env.GROQ_API_KEY;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const date = todayIST();

  // ---- Load inputs: fresh snapshot (07:45 run), yesterday's intraday store, open positions ----
  let sd = null;
  try { const f = await ghGetFile('data/nse-snapshot.json', ghToken); sd = f.content ? JSON.parse(f.content)?.data : null; } catch (e) {}
  if (!sd) return res.status(200).json({ status: 'no_snapshot', note: 'snapshot missing — watchlist not built' });

  const surveillance = new Set((sd.surveillance || []).map(s => String(s).toUpperCase()));
  const uniBySym = new Map();
  for (const r of (sd.universe || [])) if (r.symbol) uniBySym.set(String(r.symbol).toUpperCase(), r);

  let store = null;
  try { const f = await ghGetFile('data/intraday-candidates.json', ghToken); store = f.content ? JSON.parse(f.content) : null; } catch (e) {}

  const held = new Set();
  try {
    const f = await ghGetFile('data/project-bouquet.json', ghToken);
    for (const b of (f.content ? JSON.parse(f.content).bouquet || [] : [])) {
      if (!b.status || b.status === 'OPEN') held.add(String(b.ticker).toUpperCase());
    }
  } catch (e) {}

  // ---- 1. Overnight filings: filed after yesterday's 15:30 close, non-routine, liquid ----
  // Cutoff in the same as-parsed frame as parseAnnMs (IST wall clock).
  const yesterday = new Date(Date.now() + 5.5 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  const cutoffMs = Date.parse(yesterday.replace(/-/g, '/') + ' 15:30:00');
  const filersBySym = new Map();
  for (const a of (sd.announcements || [])) {
    const sym = String(a.symbol || '').toUpperCase();
    if (!sym || !uniBySym.has(sym) || surveillance.has(sym) || held.has(sym)) continue;
    const t = parseAnnMs(a.date);
    if (t == null || t < cutoffMs) continue;
    if (ROUTINE_RE.test(a.subject || '')) continue;
    if (!filersBySym.has(sym)) filersBySym.set(sym, []);
    filersBySym.get(sym).push({ subject: a.subject, date: a.date, ms: t });
  }

  // Classify the most promising overnight filers (LLM budget-capped, newest filings first).
  const filers = [...filersBySym.entries()]
    .sort((a, b) => Math.max(...b[1].map(f => f.ms)) - Math.max(...a[1].map(f => f.ms)))
    .slice(0, MAX_LLM_CLASSIFY);
  const catalystMemoryUpdates = {};
  const overnight = [];
  for (const [sym, filings] of filers) {
    if (!apiKey) break;
    const articles = filings.map(f => ({ title: '[OFFICIAL NSE FILING] ' + f.subject, url: '', publishedAt: f.ms, source: 'nse-filing' }));
    let scored = null;
    try {
      const cls = await classifyCatalyst(sym, articles, apiKey);
      scored = scoreCatalyst(cls, articles);
    } catch (e) { scored = null; }
    if (scored?.hasCatalyst && !scored.negative) {
      overnight.push({ ticker: sym, source: 'overnight-filing', catalyst: { type: scored.type, verification: scored.verification, impactClass: scored.impactClass, points: scored.points, summary: scored.summary }, prevClose: uniBySym.get(sym)?.lastPrice ?? null });
      const mem = rememberCatalyst(scored);
      if (mem) catalystMemoryUpdates[sym] = mem; // pre-warm the whole day's scans
    }
  }

  // ---- 2. Warm carryover: yesterday's strong unbought finishers ----
  const warm = [];
  if (store && store.date && store.date < date) {
    for (const [sym, e] of Object.entries(store.candidates || {})) {
      if (e.status === 'bought' || held.has(sym) || surveillance.has(sym)) continue;
      const lastScan = e.scans?.[e.scans.length - 1];
      if ((e.bestConfidence ?? 0) >= WARM_MIN_CONF) {
        warm.push({
          ticker: sym, source: 'warm-carryover',
          yBestConf: e.bestConfidence, yLastRelVol: lastScan?.relVol ?? null,
          yTrend: e.confidenceTrend ?? 'flat', catalyst: null,
          prevClose: uniBySym.get(sym)?.lastPrice ?? null,
        });
      }
    }
    warm.sort((a, b) => (b.yBestConf ?? 0) - (a.yBestConf ?? 0));
  }

  // Merge (a name can be both — filing wins as the stronger evidence), cap the list.
  const bySym = new Map();
  for (const w of [...overnight, ...warm]) {
    const prev = bySym.get(w.ticker);
    if (!prev) bySym.set(w.ticker, w);
    else bySym.set(w.ticker, { ...w, ...prev, source: 'both', yBestConf: prev.yBestConf ?? w.yBestConf, catalyst: prev.catalyst || w.catalyst });
  }
  const watch = [...bySym.values()].slice(0, MAX_WATCHLIST);

  // ---- Persist: watchlist + catalyst-memory pre-warm ----
  await ghPutWithRetry('data/premarket-watchlist.json', () => ({ date, builtAt: new Date().toISOString(), watch }), ghToken, `Premarket watchlist (${date}): ${watch.length} names`);
  if (Object.keys(catalystMemoryUpdates).length) {
    await ghPutWithRetry('data/catalyst-memory.json', (existing) => {
      const mem = existing && existing.catalysts ? existing : { catalysts: {} };
      for (const [sym, m] of Object.entries(catalystMemoryUpdates)) {
        const prev = mem.catalysts[sym];
        mem.catalysts[sym] = prev ? { ...m, firstSeenMs: prev.firstSeenMs || m.firstSeenMs } : m;
      }
      return mem;
    }, ghToken, `Premarket: ${Object.keys(catalystMemoryUpdates).length} overnight catalyst(s)`);
  }

  return res.status(200).json({
    status: 'ok', date,
    overnightFilers: filersBySym.size, classified: filers.length,
    verifiedOvernightCatalysts: overnight.map(o => ({ ticker: o.ticker, type: o.catalyst.type })),
    warmCarryovers: warm.map(w => ({ ticker: w.ticker, yBestConf: w.yBestConf })),
    watchlist: watch.map(w => w.ticker),
  });
}
