// Discovers today's candidate stocks dynamically from live news + market movers.
// Falls back to Nifty-50 if live sources come up empty.
//
// PRIORITY 1 (Phase 3): the wide NSE universe is now ordered by a composite DISCOVERY SCORE
// (see _discovery-score.js) instead of raw today's-% gain, so the expensive downstream work is
// spent on emerging-momentum names, not stocks that already made their move.

import { rankByDiscoveryScore, normalizeWeights } from './_discovery-score.js';
import { sectorStrength, sectorScoreFor } from './_sector.js';

// Nifty-50 constituents (fallback + name→symbol resolution aid)
export const NIFTY50 = [
  'Reliance Industries','TCS','HDFC Bank','Infosys','ICICI Bank','Bharti Airtel',
  'Larsen & Toubro','State Bank of India','Axis Bank','Kotak Mahindra Bank',
  'Hindustan Unilever','ITC','Bajaj Finance','Maruti Suzuki','Sun Pharma',
  'Tata Motors','NTPC','Power Grid','UltraTech Cement','Asian Paints','Titan',
  'Wipro','Adani Ports','Coal India','JSW Steel','Tata Steel','Mahindra & Mahindra',
  'Nestle India','Bajaj Auto','Hindalco','HCL Technologies','Tech Mahindra',
  'Bajaj Finserv','Adani Enterprises','ONGC','Grasim','Cipla','Dr Reddy','Eicher Motors',
  'Britannia','Apollo Hospitals','Divis Labs','Hero MotoCorp','SBI Life','HDFC Life',
  'Tata Consumer','BPCL','Shriram Finance','Trent','IndusInd Bank'
];

// V2 universe-expansion knobs. Tradeability floors applied when reading the wide
// `data.universe` snapshot field (mirrors _scoring.js JUNK_FILTER semantics).
// UNIVERSE_CANDIDATE_CAP bounds how many names discovery hands downstream — the real
// per-name cost (1y prices + fundamentals) is gated in stock-of-the-day.js, but we
// still cap here so a runaway universe can't balloon the candidate list.
const UNIVERSE_MIN_PRICE = 20;
const UNIVERSE_MIN_VOLUME = 50000;
const UNIVERSE_CANDIDATE_CAP = 120; // was effectively 15; wide universe ranked by pChange

// Fetch with a hard timeout so a hanging source can't blow the serverless limit
async function fetchWithTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Read the NSE snapshot committed by the GitHub Action (real movers/delivery/bulk
// deals — fetched from GitHub's unblocked IPs, unlike Vercel which NSE 403s).
// Returns { gainers:[{symbol,pChange,volume,index}], bulkSymbols:Set, stale:bool } or null.
async function readNseSnapshot() {
  try {
    const url = 'https://raw.githubusercontent.com/pranaykushnaji/stock-advisor-ai/main/data/nse-snapshot.json';
    const r = await fetchWithTimeout(url, {}, 4000);
    if (!r.ok) return null;
    const snap = await r.json();
    const data = snap?.data || {};
    const gainers = (data.topGainers || []).map(g => ({
      symbol: g.symbol, pChange: g.pChange, volume: g.totalTradedVolume, index: g.index,
    })).filter(g => g.symbol);
    // V2: full liquid universe (superset field). Present only on snapshots written by the
    // expanded fetcher; older snapshots don't have it, so callers must handle empty.
    // Layer JUNK_FILTER-style tradeability on top of the fetch-side pre-filter.
    // Keep dayHigh/dayLow/lastPrice/totalTradedVolume so the discovery score can read the day
    // range (closing strength) and traded value (liquidity) without another fetch.
    const universe = (data.universe || []).map(u => ({
      symbol: u.symbol, pChange: u.pChange, price: u.lastPrice, lastPrice: u.lastPrice,
      volume: u.totalTradedVolume, totalTradedVolume: u.totalTradedVolume,
      dayHigh: u.dayHigh, dayLow: u.dayLow, index: u.index,
    })).filter(u =>
      u.symbol &&
      (u.price == null || u.price >= UNIVERSE_MIN_PRICE) &&
      (u.volume == null || u.volume >= UNIVERSE_MIN_VOLUME)
    );
    // Symbols with institutional bulk/block buying today (a confirmation signal).
    // NOTE: NSE symbols here (e.g. "ATALREAL"); matching against them is fixed in
    // discoverCandidates via symbol-aware comparison (see bulkConfirmed below).
    const bulkSymbols = new Set();
    for (const d of (data.bulkDeals || [])) {
      const sym = d?.symbol || d?.SYMBOL;
      const type = (d?.buySell || d?.BUY_SELL || '').toString().toUpperCase();
      if (sym && type.includes('B')) bulkSymbols.add(String(sym).toUpperCase().trim());
    }
    for (const d of (data.blockDeals || [])) {
      const sym = d?.symbol || d?.SYMBOL;
      const type = (d?.buySell || d?.BUY_SELL || '').toString().toUpperCase();
      if (sym && type.includes('B')) bulkSymbols.add(String(sym).toUpperCase().trim());
    }
    // Symbols with a fresh official filing/announcement (cheap catalyst-present flag for discovery).
    const announcementSymbols = new Set();
    for (const a of (data.announcements || [])) {
      const sym = a?.symbol || a?.SYMBOL;
      if (sym) announcementSymbols.add(String(sym).toUpperCase().trim());
    }
    // Staleness: snapshot older than ~20h means the Action may be failing.
    const fetchedAt = snap?.fetchedAt ? new Date(snap.fetchedAt).getTime() : 0;
    const stale = !fetchedAt || (Date.now() - fetchedAt) > 20 * 3600 * 1000;
    return { gainers, universe, bulkSymbols, announcementSymbols, stale, fetchedAt: snap?.fetchedAt || null };
  } catch (e) { return null; }
}

// Fetch Google News RSS for a query, return headlines
async function fetchNewsHeadlines(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
    if (!r.ok) return [];
    const text = await r.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(text)) !== null && items.length < 25) {
      const title = (match[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      if (title) items.push(title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
    }
    return items;
  } catch (e) { return []; }
}

// Attempt to pull NSE top gainers + most active (best-effort; NSE often blocks datacenter IPs)
async function fetchMovers() {
  const movers = [];
  const endpoints = [
    'https://www.nseindia.com/api/live-analysis-variations?index=gainers',
    'https://www.nseindia.com/api/live-analysis-most-active-securities?index=volume'
  ];
  for (const url of endpoints) {
    try {
      const r = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
          'Referer': 'https://www.nseindia.com/'
        }
      }, 4000);
      if (!r.ok) continue;
      const d = await r.json();
      const rows = d?.NIFTY?.data || d?.data || d?.legends || [];
      for (const row of rows) {
        if (row?.symbol) movers.push(row.symbol);
      }
    } catch (e) { continue; }
  }
  return movers;
}

// Use the LLM to extract Indian stock names from news headlines
async function extractStocksFromNews(headlines, apiKey) {
  if (!headlines.length) return [];
  const prompt = `From these Indian market news headlines, extract the names of individual NSE-listed companies being discussed (earnings, orders, upgrades, deals, price moves). Return ONLY a JSON array of company names, max 15, most newsworthy first. No indices, no sectors, no commentary.

Headlines:
${headlines.slice(0, 25).map((h, i) => `${i + 1}. ${h}`).join('\n')}

Return ONLY: ["Company A","Company B",...]`;
  try {
    const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2, max_tokens: 500
      })
    }, 8000);
    if (!r.ok) return [];
    const d = await r.json();
    let text = d?.choices?.[0]?.message?.content || '';
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    if (s < 0 || e < 0) return [];
    return JSON.parse(text.slice(s, e + 1)).filter(x => typeof x === 'string');
  } catch (e) { return []; }
}

// Normalize a company name/ticker for dedup (strip suffixes, punctuation, common words)
function normName(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/\b(LTD|LIMITED|INDIA|INDUSTRIES|CORPORATION|CORP|COMPANY|CO|ENTERPRISES|THE)\b/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

// Main: returns { candidates: [...], sources: {...}, discoveryMeta: Map }
// opts.prevVolumes: optional Map(symbol -> { volume, frac }) from the previous intraday scan,
//   enabling the cross-scan volume-acceleration signal in the discovery score.
// opts.sessionFrac: fraction of today's session elapsed (0-1), for that same signal.
export async function discoverCandidates(apiKey, opts = {}) {
  const sources = { news: 0, movers: 0, nseSnapshot: 0, nseUniverse: 0, usedFallback: false,
    diag: { headlinesFetched: 0, newsQueryUsed: null, extractError: null, moversError: null, snapshotStale: null, snapshotAt: null, rankedBy: 'pChange' } };
  const discoveryMeta = new Map(); // symbol -> { discoveryScore, discoveryParts, discoveryReasons }

  // 0. PRIMARY source: real NSE movers from the committed snapshot (GitHub Action
  //    fetches these from unblocked IPs). This is the day's ACTUAL gainers — the
  //    biggest discovery improvement. Includes mid-caps momentum actually lives in.
  //    V2: prefer the full liquid `universe` (500-800 names) when the expanded fetcher
  //    has written it; fall back to the legacy top-30 `gainers` on older snapshots.
  const snap = await readNseSnapshot();
  let snapshotGainers = [];
  let bulkBuySymbols = new Set();
  if (snap) {
    bulkBuySymbols = snap.bulkSymbols || new Set();
    const announcementSymbols = snap.announcementSymbols || new Set();
    sources.diag.snapshotStale = snap.stale;
    sources.diag.snapshotAt = snap.fetchedAt;
    const wide = Array.isArray(snap.universe) ? snap.universe : [];
    if (wide.length) {
      // PRIORITY 1: rank the wide universe by the composite DISCOVERY SCORE (emerging momentum),
      // not raw pChange. Sector strength comes from the universe's own breadth; catalyst/
      // institutional flags are cheap set lookups; volume acceleration uses the previous scan's
      // volumes when the buy-scan passes them in.
      const strengthMap = sectorStrength(wide);
      const prevVolumes = opts.prevVolumes || null;
      const curFrac = opts.sessionFrac ?? null;
      // V2: adaptive weights (quarterly-optimized points from data/discovery-weights.json,
      // passed in by the buy scan); defaults apply when absent/malformed.
      const dw = normalizeWeights(opts.discoveryWeights);
      const rankedRows = rankByDiscoveryScore(wide, (row) => {
        const sym = String(row.symbol || '').toUpperCase();
        const prev = prevVolumes ? prevVolumes.get(sym) : null;
        return {
          sectorScore: sectorScoreFor(sym, strengthMap),
          hasCatalyst: announcementSymbols.has(sym),
          institutional: bulkBuySymbols.has(sym),
          curFrac,
          prevVolume: prev?.volume ?? null,
          prevFrac: prev?.frac ?? null,
        };
      }, dw);
      snapshotGainers = rankedRows.map(u => u.symbol);
      for (const u of rankedRows) discoveryMeta.set(String(u.symbol).toUpperCase(), { discoveryScore: u.discoveryScore, discoveryParts: u.discoveryParts, discoveryReasons: u.discoveryReasons, tradedValueCr: u.tradedValueCr });
      sources.diag.rankedBy = 'discoveryScore';
      sources.nseUniverse = snapshotGainers.length;
      sources.nseSnapshot = snapshotGainers.length;
    } else if (Array.isArray(snap.gainers)) {
      snapshotGainers = snap.gainers.map(g => g.symbol);
      sources.nseSnapshot = snapshotGainers.length;
    }
  }

  // 1. Live news → stock names. Try multiple queries so one dud query doesn't zero us out.
  const newsQueries = [
    'NSE stocks surge rally today',
    'NSE India stocks buy target earnings results today',
    'Nifty top gainers movers today',
  ];
  let headlines = [];
  for (const q of newsQueries) {
    headlines = await fetchNewsHeadlines(q);
    if (headlines.length >= 5) { sources.diag.newsQueryUsed = q; break; }
  }
  sources.diag.headlinesFetched = headlines.length;

  let newsStocks = [];
  if (headlines.length) {
    try {
      newsStocks = await extractStocksFromNews(headlines, apiKey);
    } catch (e) {
      sources.diag.extractError = String(e?.message || e).slice(0, 100);
    }
  }
  sources.news = newsStocks.length;

  // 2. Legacy NSE-direct movers (best-effort; usually 403s from Vercel — snapshot supersedes)
  let moverSymbols = [];
  try {
    moverSymbols = await fetchMovers();
  } catch (e) {
    sources.diag.moversError = String(e?.message || e).slice(0, 100);
  }
  sources.movers = moverSymbols.length;

  // Combine, snapshot gainers FIRST (highest-priority real movers), then news, then legacy.
  const seen = new Set();
  let candidates = [];
  for (const name of [...snapshotGainers, ...newsStocks, ...moverSymbols]) {
    if (typeof name !== 'string') continue;
    const clean = name.trim();
    if (!clean || clean.length < 2 || clean.length > 60) continue;
    const key = normName(clean);
    if (key && !seen.has(key)) { seen.add(key); candidates.push(clean); }
  }

  // 3. Fallback to Nifty-50 only if everything above came up short
  if (candidates.length < 5) {
    sources.usedFallback = true;
    for (const name of NIFTY50) {
      const key = normName(name);
      if (!seen.has(key)) { seen.add(key); candidates.push(name); }
    }
  }

  // Cap the candidate list. With the wide universe this is much larger than the old 15;
  // the expensive per-name work (1y prices + fundamentals) is shortlisted downstream in
  // stock-of-the-day.js, so a bigger candidate pool here is cheap (just strings).
  // Older snapshots (no universe) still produce a small list, so the cap is a ceiling.
  candidates = candidates.slice(0, UNIVERSE_CANDIDATE_CAP);

  // Expose which candidates have institutional bulk-buying today (confirmation signal).
  // FIX: bulkBuySymbols holds NSE SYMBOLS (e.g. "ATALREAL") but candidates are often
  // company NAMES ("Reliance Industries"), so the old exact-match returned empty. We now
  // compare on normalized forms both ways so symbol- and name-based candidates both match.
  const bulkNormSet = new Set([...bulkBuySymbols].map(s => normName(s)));
  const bulkConfirmed = candidates.filter(c => {
    const upper = c.toUpperCase().trim();
    const norm = normName(c);
    return bulkBuySymbols.has(upper) || bulkNormSet.has(norm);
  });
  return { candidates, sources, bulkConfirmed, discoveryMeta };
}
