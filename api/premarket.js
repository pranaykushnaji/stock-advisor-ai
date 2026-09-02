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
import { classifyCatalyst, scoreCatalyst, rememberCatalyst, CATALYST_STARS, eventImpact } from './_catalyst.js';
import { requireCronAuth } from './_cron-auth.js';
import { parseNseDateMs, istDateTimeToUtcMs } from './_nse-date.js';

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
export default async function handler(req, res) {
  if (!requireCronAuth(req, res)) return;

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
  // Yesterday's 15:30 IST close expressed as an absolute UTC timestamp.
  const yesterday = new Date(Date.now() + 5.5 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  const cutoffMs = istDateTimeToUtcMs(yesterday, '15:30:00');
  const filersBySym = new Map();
  for (const a of (sd.announcements || [])) {
    const sym = String(a.symbol || '').toUpperCase();
    if (!sym || !uniBySym.has(sym) || surveillance.has(sym) || held.has(sym)) continue;
    const t = parseNseDateMs(a.date);
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

  // ---- 3. NEWS INTELLIGENCE (Claude scheduled routine, data/news-intel.json) ----
  // A daily Claude agent researches the open web overnight (coverage the 5 news APIs lack —
  // this is what was blind to PAYTM/BANDHANBNK-style moves) and writes pre-classified items.
  // Trust model: an item citing 2+ independent reputable sources = VERIFIED (same bar as
  // cross-source news); 1 source = PARTIAL. Freshness-gated: if the routine didn't run (the
  // laptop was off — it runs locally in the Claude app), a stale file is IGNORED and the
  // pipeline behaves exactly as before. Enrichment, never load-bearing.
  let newsIntelUsed = 0;
  let marketContext = null; // Claude's morning market analysis — advisory context, never a gate
  let newsIntelStatus = 'missing';
  const intelWatch = [];
  try {
    const f = await ghGetFile('data/news-intel.json', ghToken);
    const ni = f.content ? JSON.parse(f.content) : null;
    const ageH = ni?.generatedAt ? (Date.now() - Date.parse(ni.generatedAt)) / 3600000 : Infinity;
    newsIntelStatus = ageH <= 20 ? 'fresh' : (isFinite(ageH) ? `stale:${Math.round(ageH)}h` : 'missing');
    if (ageH <= 20 && ni.marketContext) marketContext = ni.marketContext;
    if (ageH <= 20 && Array.isArray(ni.items)) {
      for (const it of ni.items.slice(0, 25)) {
        const sym = String(it.ticker || '').toUpperCase();
        if (!sym || !uniBySym.has(sym) || surveillance.has(sym) || held.has(sym)) continue;
        if (String(it.direction) !== 'positive' || (it.materiality ?? 0) < 6) continue;
        const type = String(it.eventType || 'general news').toLowerCase();
        const verified = (Array.isArray(it.sources) ? it.sources.length : 0) >= 2;
        const stars = CATALYST_STARS[type] ?? 3;
        if (stars <= 1) continue; // fluff never drives a watchlist slot
        newsIntelUsed++;
        intelWatch.push({
          ticker: sym, source: 'news-intel',
          catalyst: { type, verification: verified ? 'VERIFIED' : 'PARTIAL', impactClass: eventImpact(type).class, points: verified ? Math.round((stars / 5) * 34) : Math.round((stars / 5) * 18), summary: it.summary || null },
          prevClose: uniBySym.get(sym)?.lastPrice ?? null,
        });
        // VERIFIED web-researched catalysts also pre-warm the day's catalyst memory so every
        // hourly scan sees them — same treatment as an official filing.
        if (verified && !catalystMemoryUpdates[sym]) {
          catalystMemoryUpdates[sym] = { type, stars, verification: 'VERIFIED', impactClass: eventImpact(type).class, summary: it.summary || null, firstSeenMs: Date.now(), lastConfirmedMs: Date.now() };
        }
      }
    }
  } catch (e) { /* malformed/missing intel file → ignore, filings-only as before */ }

  // The optional laptop routine must never leave the morning context blank. When it is stale,
  // derive a modest, fully deterministic tape summary from the fresh NSE snapshot.
  if (!marketContext) {
    const rows = [...uniBySym.values()].filter(r => typeof r.pChange === 'number');
    const breadth = rows.length ? rows.filter(r => r.pChange > 0).length / rows.length : 0.5;
    const avgMove = rows.length ? rows.reduce((a, r) => a + r.pChange, 0) / rows.length : 0;
    const tone = breadth >= 0.62 && avgMove > 0 ? 'bullish' : breadth <= 0.38 || avgMove < -0.5 ? 'weak' : 'neutral';
    marketContext = {
      tone,
      summary: `Deterministic NSE breadth fallback: ${Math.round(breadth * 100)}% advancers, average move ${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(2)}%.`,
      sectorsInFocus: [],
      source: 'nse-snapshot-fallback',
    };
  }

  // Merge (a name can appear in several — filing wins as the strongest evidence, then intel,
  // then warm carryover), cap the list.
  const bySym = new Map();
  for (const w of [...overnight, ...intelWatch, ...warm]) {
    const prev = bySym.get(w.ticker);
    if (!prev) bySym.set(w.ticker, w);
    else bySym.set(w.ticker, { ...w, ...prev, source: 'both', yBestConf: prev.yBestConf ?? w.yBestConf, catalyst: prev.catalyst || w.catalyst });
  }
  const watch = [...bySym.values()].slice(0, MAX_WATCHLIST);

  // ---- Persist: watchlist (+ morning market context for downstream advisors) + memory ----
  await ghPutWithRetry('data/premarket-watchlist.json', () => ({ date, builtAt: new Date().toISOString(), marketContext, watch }), ghToken, `Premarket watchlist (${date}): ${watch.length} names`);
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
    marketTone: marketContext?.tone ?? null, newsIntelStatus,
    overnightFilers: filersBySym.size, classified: filers.length,
    verifiedOvernightCatalysts: overnight.map(o => ({ ticker: o.ticker, type: o.catalyst.type })),
    newsIntel: intelWatch.map(w => ({ ticker: w.ticker, type: w.catalyst.type, verification: w.catalyst.verification })),
    warmCarryovers: warm.map(w => ({ ticker: w.ticker, yBestConf: w.yBestConf })),
    watchlist: watch.map(w => w.ticker),
  });
}
