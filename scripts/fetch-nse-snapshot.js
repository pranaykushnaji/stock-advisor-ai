// scripts/fetch-nse-snapshot.js
// Runs on a GitHub Actions runner (NOT Vercel) to fetch NSE data that Vercel's
// datacenter IPs get 403'd on. Writes data/nse-snapshot.json for the app to read.
// ES module syntax (package.json has "type": "module").

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NseIndia } from 'stock-nse-india';
import { parseNseDateMs } from '../api/_nse-date.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const n = new NseIndia();
const OUT = path.join(__dirname, '..', 'data', 'nse-snapshot.json');

// Retry/backoff wrapper. NSE rate-limits at the wider universe volume where the old
// 4-index scan didn't — so each index fetch gets a couple of retries with growing
// backoff, and we throttle BETWEEN indices (see UNIVERSE_INDICES loop) to stay polite.
async function tryFetch(label, fn, { retries = 2, backoffMs = 1500 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await fn();
      console.log(`  OK   ${label}${attempt ? ` (attempt ${attempt + 1})` : ''}`);
      return { ok: true, data };
    } catch (e) {
      lastErr = e;
      const msg = (e.message || e).toString().slice(0, 100);
      if (attempt < retries) {
        const wait = backoffMs * (attempt + 1);
        console.log(`  RETRY ${label}: ${msg} — waiting ${wait}ms`);
        await sleep(wait);
      } else {
        console.log(`  FAIL ${label}: ${msg}`);
      }
    }
  }
  return { ok: false, error: (lastErr?.message || lastErr || 'unknown').toString().slice(0, 200) };
}

// Simple sleep for throttling between requests.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Coerce NSE's string-or-number numeric fields (lastPrice etc. arrive as strings).
function toNum(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

(async () => {
  console.log('Fetching NSE snapshot from GitHub Actions runner...');
  const snapshot = { fetchedAt: new Date().toISOString(), diag: {}, data: {} };

  // 1. Market status (cheapest probe — if this 403s, everything will)
  const status = await tryFetch('getMarketStatus', () => n.getMarketStatus());
  snapshot.diag.marketStatus = status.ok;
  if (status.ok) snapshot.data.marketStatus = status.data;

  // 2. Gainers/losers AND full liquid universe across the broad NSE indices.
  //    V2 universe expansion: was 4 indices → now covers Nifty-500-equivalent breadth
  //    (large + mid + small + F&O) so discovery sees ~500-800 liquid names, not ~210.
  //    These are INDEX endpoints (one call returns every constituent), so widening the
  //    list costs a handful of extra calls, not one-per-stock. We still throttle between
  //    them because NSE rate-limits the broader endpoints harder than NIFTY 50.
  const UNIVERSE_INDICES = [
    'NIFTY 50',
    'NIFTY NEXT 50',
    'NIFTY MIDCAP 100',
    'NIFTY MIDCAP 150',
    'NIFTY SMALLCAP 100',
    'NIFTY SMALLCAP 250',
    'NIFTY 500',
    'SECURITIES IN F&O',
  ];
  // 2026-08-06: only 1 of 8 indices was actually landing (universe = 203 F&O names instead of
  // the intended 500-800 incl. midcaps/smallcaps), and `universeIndicesScanned: 8` hid it by
  // counting ATTEMPTS, not successes. NSE needs a warm session (cookies) before the heavier
  // index endpoints answer, so: warm up first, retry harder, throttle wider, and record the
  // per-index outcome in diag so a silent partial fetch can never look healthy again.
  const THROTTLE_MS = 2500; // wider gap — NSE rate-limits the broad index endpoints
  const movers = [];
  const indexDiag = {};
  await tryFetch('session warm-up', () => n.getEquityStockIndices('NIFTY 50'), { retries: 3, backoffMs: 2000 });
  await sleep(THROTTLE_MS);
  for (let i = 0; i < UNIVERSE_INDICES.length; i++) {
    const idxName = UNIVERSE_INDICES[i];
    const r = await tryFetch(`stockIndices ${idxName}`, () => n.getEquityStockIndices(idxName), { retries: 4, backoffMs: 2000 });
    indexDiag[idxName] = (r.ok && Array.isArray(r.data?.data)) ? r.data.data.length : 0;
    if (r.ok && Array.isArray(r.data?.data)) {
      for (const s of r.data.data) {
        if (s.symbol && s.symbol !== idxName && typeof s.pChange === 'number') {
          movers.push({
            symbol: s.symbol, pChange: s.pChange, lastPrice: s.lastPrice,
            dayHigh: s.dayHigh, dayLow: s.dayLow,
            totalTradedVolume: s.totalTradedVolume, index: idxName,
          });
        }
      }
    }
    if (i < UNIVERSE_INDICES.length - 1) await sleep(THROTTLE_MS); // throttle between indices
  }
  // De-dupe by symbol (keep highest-volume record), sort by pChange desc.
  const bySymbol = new Map();
  for (const m of movers) {
    const prev = bySymbol.get(m.symbol);
    if (!prev || (m.totalTradedVolume || 0) > (prev.totalTradedVolume || 0)) bySymbol.set(m.symbol, m);
  }
  const allMovers = [...bySymbol.values()].sort((a, b) => b.pChange - a.pChange);
  snapshot.diag.moversCount = allMovers.length;

  // BACKWARD-COMPAT: keep topGainers/topLosers exactly as before so _discover.js and
  // anything else reading the old schema keeps working with ZERO changes.
  snapshot.data.topGainers = allMovers.slice(0, 30);
  snapshot.data.topLosers = allMovers.slice(-15).reverse();

  // NEW (superset field): the full de-duped liquid universe with a lightweight
  // tradeability pre-filter applied on the Actions side. _discover.js reads this when
  // present and falls back to topGainers when it isn't. Numbers are coerced from NSE's
  // string form so downstream consumers get real numbers.
  //   UNIVERSE_FILTER lives here (fetch side) so junk never even enters the committed
  //   JSON; _discover.js layers its own JUNK_FILTER on top at read time.
  const UNIVERSE_FILTER = {
    MIN_PRICE: 20,          // no sub-₹20 penny names (mirrors JUNK_FILTER.MIN_PRICE)
    MIN_TRADED_VOLUME: 50000, // day's traded volume floor — drops illiquid shells
  };
  const universe = allMovers
    .map((m) => ({
      symbol: m.symbol,
      pChange: m.pChange,
      lastPrice: toNum(m.lastPrice),
      dayHigh: toNum(m.dayHigh),
      dayLow: toNum(m.dayLow),
      totalTradedVolume: toNum(m.totalTradedVolume),
      index: m.index,
    }))
    .filter((m) =>
      m.lastPrice != null &&
      m.lastPrice >= UNIVERSE_FILTER.MIN_PRICE &&
      (m.totalTradedVolume ?? 0) >= UNIVERSE_FILTER.MIN_TRADED_VOLUME
    );
  snapshot.data.universe = universe;
  snapshot.diag.universeCount = universe.length;
  snapshot.diag.universeIndicesScanned = UNIVERSE_INDICES.length;
  // Per-index row counts + how many actually returned data. `indicesOk` is the number that
  // matters — `universeIndicesScanned` only ever counted attempts and masked a 1-of-8 fetch.
  snapshot.diag.indexRows = indexDiag;
  snapshot.diag.indicesOk = Object.values(indexDiag).filter(n => n > 0).length;

  // 3. Bulk & block deals (institutional activity — alt-data spec section)
  const bulk = await tryFetch('bulk deals', () => n.getDataByEndpoint('/api/snapshot-capital-market-largedeal'));
  snapshot.diag.largeDeals = bulk.ok;
  if (bulk.ok) {
    snapshot.data.bulkDeals = (bulk.data?.BULK_DEALS_DATA || []).slice(0, 30);
    snapshot.data.blockDeals = (bulk.data?.BLOCK_DEALS_DATA || []).slice(0, 30);
    snapshot.data.shortDeals = (bulk.data?.SHORT_DEALS_DATA || []).slice(0, 20);
  }

  // 3b. ASM/GSM surveillance list — best-effort. Stocks under Additional/Graded Surveillance
  //     are operator-prone; the pick filter hard-rejects them. If the endpoint shape changes
  //     or NSE blocks it, this just stays empty and the filter simply skips the surveillance
  //     check (graceful). Symbols are collected from whatever nested arrays are present.
  const asm = await tryFetch('ASM list', () => n.getDataByEndpoint('/api/reportASM'));
  snapshot.diag.surveillance = asm.ok;
  if (asm.ok) {
    const syms = [];
    const pull = (arr) => { for (const x of (arr || [])) { const s = x?.symbol || x?.SYMBOL; if (s) syms.push(String(s).toUpperCase().trim()); } };
    pull(asm.data?.longterm?.data);
    pull(asm.data?.shortterm?.data);
    pull(asm.data?.data);
    snapshot.data.surveillance = [...new Set(syms)];
  }

  // 3c. Corporate announcements (official filings) — the AUTHORITATIVE catalyst source for
  //     Indian stocks. Fetched from GitHub's unblocked IP (Vercel/global news APIs barely
  //     cover Indian mid/small-caps). Keep the last ~72h; the catalyst engine treats a fresh
  //     filing as a VERIFIED catalyst and lets the LLM classify the filing subject.
  // Pull the full trailing 3-day window (NSE wants DD-MM-YYYY) so we capture ALL recent
  // filings, not just the latest ~20 the default call returns.
  const _pad = (x) => String(x).padStart(2, '0');
  const _fmt = (d) => `${_pad(d.getDate())}-${_pad(d.getMonth() + 1)}-${d.getFullYear()}`;
  const annEndpoint = `/api/corporate-announcements?index=equities&from_date=${_fmt(new Date(Date.now() - 3 * 86400000))}&to_date=${_fmt(new Date())}`;
  const ann = await tryFetch('announcements', () => n.getDataByEndpoint(annEndpoint));
  snapshot.diag.announcements = ann.ok;
  if (ann.ok) {
    const list = Array.isArray(ann.data) ? ann.data : (ann.data?.data || []);
    const cutoff = Date.now() - 72 * 3600 * 1000;
    const rows = [];
    for (const a of list) {
      const sym = a?.symbol || a?.SYMBOL;
      if (!sym) continue;
      const rawDt = a?.an_dt || a?.sort_date || a?.exchdisstime || a?.broadcastdate || null;
      const t = rawDt ? parseNseDateMs(rawDt) : Date.now();
      if (isFinite(t) && t < cutoff) continue;
      const subject = (a?.desc || a?.attchmntText || a?.sub || a?.smIndustry || '').toString().replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!subject) continue;
      rows.push({ symbol: String(sym).toUpperCase().trim(), subject, date: rawDt });
      if (rows.length >= 500) break;
    }
    snapshot.data.announcements = rows;
    snapshot.diag.announcementCount = rows.length;
  }

  // 4. Sample delivery % for a couple names (proves per-stock delivery data works)
  const delivProbe = await tryFetch('delivery (RELIANCE)', () => n.getEquityDetails('RELIANCE'));
  snapshot.diag.deliveryData = delivProbe.ok;
  if (delivProbe.ok) {
    const sec = delivProbe.data?.securityInfo || {};
    const trade = delivProbe.data?.priceInfo || {};
    snapshot.data.deliverySample = {
      symbol: 'RELIANCE',
      note: 'delivery% available via getEquityTradeInfo per-symbol at read time',
    };
  }

  // Never replace the last known-good database snapshot with an empty diagnostic. The buy engine
  // needs a broad universe; a tiny/empty response means NSE was blocked or its schema changed.
  if ((snapshot.data.universe || []).length < 50) {
    throw new Error(`snapshot validation failed: universe has only ${(snapshot.data.universe || []).length} rows`);
  }

  fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log('Diagnostic summary:', JSON.stringify(snapshot.diag));

  const anySuccess = Object.values(snapshot.diag).some(v => v === true || (typeof v === 'number' && v > 0));
  if (!anySuccess) {
    console.log('\n>>> RESULT: NSE appears BLOCKED from this GitHub runner (all fetches failed).');
  } else {
    console.log('\n>>> RESULT: NSE is REACHABLE from GitHub. Free NSE data unlocked.');
  }
})().catch(e => {
  // Preserve the previous committed snapshot and fail loudly. A green workflow with an empty
  // database is more dangerous than a failed workflow with the last known-good data intact.
  console.error('Snapshot fetch failed:', e?.message || e);
  process.exitCode = 1;
});
