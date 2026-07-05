// Discovers today's candidate stocks dynamically from live news + market movers.
// Falls back to Nifty-50 if live sources come up empty.

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
    // Symbols with institutional bulk/block buying today (a confirmation signal).
    const bulkSymbols = new Set();
    for (const d of (data.bulkDeals || [])) {
      const sym = d?.symbol || d?.SYMBOL;
      const type = (d?.buySell || d?.BUY_SELL || '').toString().toUpperCase();
      if (sym && type.includes('B')) bulkSymbols.add(sym.toUpperCase());
    }
    // Staleness: snapshot older than ~20h means the Action may be failing.
    const fetchedAt = snap?.fetchedAt ? new Date(snap.fetchedAt).getTime() : 0;
    const stale = !fetchedAt || (Date.now() - fetchedAt) > 20 * 3600 * 1000;
    return { gainers, bulkSymbols, stale, fetchedAt: snap?.fetchedAt || null };
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

// Main: returns { candidates: [...], sources: {...} }
export async function discoverCandidates(apiKey) {
  const sources = { news: 0, movers: 0, nseSnapshot: 0, usedFallback: false,
    diag: { headlinesFetched: 0, newsQueryUsed: null, extractError: null, moversError: null, snapshotStale: null, snapshotAt: null } };

  // 0. PRIMARY source: real NSE movers from the committed snapshot (GitHub Action
  //    fetches these from unblocked IPs). This is the day's ACTUAL gainers — the
  //    biggest discovery improvement. Includes mid-caps momentum actually lives in.
  const snap = await readNseSnapshot();
  let snapshotGainers = [];
  let bulkBuySymbols = new Set();
  if (snap && Array.isArray(snap.gainers)) {
    snapshotGainers = snap.gainers.map(g => g.symbol);
    bulkBuySymbols = snap.bulkSymbols || new Set();
    sources.nseSnapshot = snapshotGainers.length;
    sources.diag.snapshotStale = snap.stale;
    sources.diag.snapshotAt = snap.fetchedAt;
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

  // Cap to keep the analysis within serverless time limits
  candidates = candidates.slice(0, 15);
  // Expose which candidates have institutional bulk-buying today (confirmation signal).
  const bulkConfirmed = candidates.filter(c => bulkBuySymbols.has(normName(c).toUpperCase()) || bulkBuySymbols.has(c.toUpperCase()));
  return { candidates, sources, bulkConfirmed };
}
