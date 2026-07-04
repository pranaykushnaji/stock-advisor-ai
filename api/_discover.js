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
  const sources = { news: 0, movers: 0, usedFallback: false,
    diag: { headlinesFetched: 0, newsQueryUsed: null, extractError: null, moversError: null } };

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

  // 2. Market movers (best-effort)
  let moverSymbols = [];
  try {
    moverSymbols = await fetchMovers();
  } catch (e) {
    sources.diag.moversError = String(e?.message || e).slice(0, 100);
  }
  sources.movers = moverSymbols.length;

  // Combine, de-dupe using normalized names (so "RELIANCE" == "Reliance Industries Ltd")
  const seen = new Set();
  let candidates = [];
  for (const name of [...newsStocks, ...moverSymbols]) {
    if (typeof name !== 'string') continue;
    const clean = name.trim();
    if (!clean || clean.length < 2 || clean.length > 60) continue; // sanity bounds
    const key = normName(clean);
    if (key && !seen.has(key)) { seen.add(key); candidates.push(clean); }
  }

  // 3. Fallback to Nifty-50 if discovery came up short
  if (candidates.length < 5) {
    sources.usedFallback = true;
    for (const name of NIFTY50) {
      const key = normName(name);
      if (!seen.has(key)) { seen.add(key); candidates.push(name); }
    }
  }

  // Cap to keep the analysis within serverless time limits
  candidates = candidates.slice(0, 15);
  return { candidates, sources };
}
