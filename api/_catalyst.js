// api/_catalyst.js
// Company-specific CATALYST detection for the momentum-swing strategy. Instead of a generic
// positive/negative sentiment, we fetch recent news from several sources, keep only the last
// 72h, ask the LLM to classify the single strongest catalyst into a concrete EVENT type, and
// convert that into a 0-40 "catalyst score" gated on high confidence + impact + freshness.
//
// This is the confirmation half of the core rule: a stock is only tradeable if it has BOTH
// high relative volume AND a high-confidence, company-specific catalyst from the last 72h.
//
// Sources (all optional except Google RSS which is keyless): Finnhub, NewsData.io, Alpha
// Vantage News, Marketaux, Google News RSS. Whatever keys are present get used; results are
// merged and de-duped. Nothing here throws — a dead source just contributes nothing.

const MAX_AGE_H = 72;      // ignore anything older than this
const FRESH_H = 48;        // <48h = full weight

// Event → star strength (1-5). Negatives (< 0) are red flags that can hard-reject a name.
export const CATALYST_STARS = {
  'government order': 5, 'government approval': 5, 'regulatory approval': 5,
  'large contract': 5, 'contract win': 5,
  'acquisition': 4, 'capacity expansion': 4, 'earnings beat': 4, 'results beat': 4,
  'promoter buying': 4, 'institution buying': 4, 'institutional buying': 4, 'debt reduction': 4,
  'broker upgrade': 3, 'new product': 3,
  'management change': 2,
  'no catalyst': 1, 'general news': 1,
  // Red flags:
  'fraud': -5, 'sebi action': -5, 'investigation': -4, 'regulatory action': -4, 'resignation': -3,
};

function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

const hoursAgo = (ms) => (Date.now() - ms) / 3600000;
function norm(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// ---- individual sources: each returns [{title, url, publishedAt(ms), source}] ----
async function srcFinnhub(base, key) {
  if (!key) return [];
  const from = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  for (const sym of [`NSE:${base}`, base]) {
    try {
      const r = await fetchWithTimeout(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${key}`);
      if (!r.ok) continue;
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) {
        return arr.map(a => ({ title: a.headline, url: a.url, publishedAt: (a.datetime || 0) * 1000, source: 'finnhub' })).filter(a => a.title);
      }
    } catch (e) { /* skip */ }
  }
  return [];
}
async function srcNewsData(query, key) {
  if (!key) return [];
  try {
    const r = await fetchWithTimeout(`https://newsdata.io/api/1/news?apikey=${key}&qInTitle=${encodeURIComponent(query)}&language=en`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.results || []).map(a => ({ title: a.title, url: a.link, publishedAt: a.pubDate ? Date.parse(a.pubDate) : Date.now(), source: 'newsdata' })).filter(a => a.title);
  } catch (e) { return []; }
}
async function srcAlphaVantage(base, key) {
  if (!key) return [];
  try {
    const r = await fetchWithTimeout(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(base + '.BSE')}&apikey=${key}&limit=20`, {}, 8000);
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.feed || []).map(a => ({
      title: a.title, url: a.url,
      publishedAt: a.time_published ? Date.parse(a.time_published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6')) : Date.now(),
      source: 'alphavantage',
    })).filter(a => a.title);
  } catch (e) { return []; }
}
async function srcMarketaux(query, key) {
  if (!key) return [];
  try {
    const r = await fetchWithTimeout(`https://api.marketaux.com/v1/news/all?search=${encodeURIComponent(query)}&language=en&filter_entities=true&api_token=${key}`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.data || []).map(a => ({ title: a.title, url: a.url, publishedAt: a.published_at ? Date.parse(a.published_at) : Date.now(), source: 'marketaux' })).filter(a => a.title);
  } catch (e) { return []; }
}
async function srcGoogle(query) {
  try {
    const r = await fetchWithTimeout(`https://news.google.com/rss/search?q=${encodeURIComponent(query + ' stock')}&hl=en-IN&gl=IN&ceid=IN:en`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
    if (!r.ok) return [];
    const text = await r.text();
    const out = [];
    const re = /<item>([\s\S]*?)<\/item>/g; let m;
    while ((m = re.exec(text)) !== null && out.length < 15) {
      const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const link = (m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const pub = (m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      if (title) out.push({ title: title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'), url: link, publishedAt: pub ? Date.parse(pub) : Date.now(), source: 'google' });
    }
    return out;
  } catch (e) { return []; }
}

// Fetch + merge + de-dupe + keep only the last MAX_AGE_H hours, newest first.
export async function fetchArticles(company, base, keys = {}) {
  const q = company || base;
  const groups = await Promise.all([
    srcFinnhub(base, keys.finnhubKey),
    srcNewsData(q, keys.newsdataKey),
    srcAlphaVantage(base, keys.alphaVantageKey),
    srcMarketaux(q, keys.marketauxKey),
    srcGoogle(q),
  ]);
  const seen = new Set();
  const merged = [];
  for (const a of groups.flat()) {
    if (!a.title || !a.publishedAt) continue;
    if (hoursAgo(a.publishedAt) > MAX_AGE_H) continue;               // freshness cut
    const key = norm(a.title).slice(0, 60) || a.url;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(a);
  }
  merged.sort((a, b) => b.publishedAt - a.publishedAt);
  return merged.slice(0, 12);
}

// Ask the LLM to classify the single strongest catalyst across the supplied articles.
export async function classifyCatalyst(company, articles, apiKey) {
  if (!articles.length || !apiKey) return null;
  const sys = `You are an equity event classifier for NSE swing trades. From the article titles for ONE company, identify the SINGLE strongest company-specific catalyst in the last 72 hours. An item prefixed [OFFICIAL NSE FILING] is an authoritative company filing — prioritize it and judge whether it is a genuine bullish catalyst (an order/contract win, results beat, capacity expansion, etc.) versus a routine filing (board meeting, trading-window closure, investor call — these are "No catalyst"). Classify into EXACTLY one type from: Government order, Large contract, Capacity expansion, Earnings beat, Broker upgrade, Promoter buying, Institution buying, New product, Regulatory approval, Debt reduction, Acquisition, Management change, Fraud, Investigation, SEBI action, Resignation, No catalyst. Ignore generic market/index commentary. Respond ONLY with strict JSON: {"catalyst_type":"<one type>","direction":"bullish"|"bearish","confidence":0-100,"impact_score":1-10,"summary":"<max 20 words>"}`;
  const user = `Company: ${company}\nArticles (newest first):\n${articles.slice(0, 10).map((a, i) => `${i + 1}. ${a.title}`).join('\n')}`;
  try {
    const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.2, max_tokens: 200 }),
    }, 9000);
    if (!r.ok) return null;
    const text = (await r.json())?.choices?.[0]?.message?.content || '';
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    return JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : text);
  } catch (e) { return null; }
}

// Freshness multiplier from the newest article age — finer buckets (momentum news decays fast).
function freshnessWeight(newestAgeH) {
  if (newestAgeH == null) return 0;
  if (newestAgeH <= 12) return 1.0;   // 0-12h
  if (newestAgeH <= 24) return 0.9;   // 12-24h
  if (newestAgeH <= 48) return 0.75;  // 24-48h
  if (newestAgeH <= MAX_AGE_H) return 0.55; // 48-72h
  return 0;
}

// Verification from independent-source count (proxy for cross-source confirmation). Phase 2
// upgrades this with true event clustering + official NSE/BSE filings.
function verify(distinctSources) {
  if (distinctSources >= 2) return { status: 'VERIFIED', mult: 1.0 };
  if (distinctSources === 1) return { status: 'PARTIAL', mult: 0.6 };
  return { status: 'UNVERIFIED', mult: 0.3 };
}

// Convert a classification + articles into the 0-40 catalyst score (+ red-flag info).
// Points are awarded ONLY for a bullish, high-confidence (>=80), high-impact (>=7),
// concrete catalyst — everything weak scores 0. Negative events are flagged for hard-reject.
export function scoreCatalyst(classification, articles) {
  const empty = { points: 0, hasCatalyst: false, negative: false, type: 'no catalyst', confidence: 0, impact: 0, stars: 0, freshness: 0, verification: 'UNVERIFIED', sources: 0, summary: null };
  if (!classification) return empty;
  const type = String(classification.catalyst_type || '').toLowerCase().trim();
  const stars = CATALYST_STARS[type] ?? 1;
  const bullish = String(classification.direction || '').toLowerCase().includes('bull');
  const confidence = Math.max(0, Math.min(100, Number(classification.confidence) || 0));
  const impact = Math.max(0, Math.min(10, Number(classification.impact_score) || 0));
  const newestAgeH = articles.length ? hoursAgo(Math.max(...articles.map(a => a.publishedAt))) : null;
  const freshness = freshnessWeight(newestAgeH);
  const distinctSources = new Set((articles || []).map(a => a.source)).size;
  const hasFiling = (articles || []).some(a => a.source === 'nse-filing');
  // An official NSE filing IS verification (strongest tier); otherwise fall back to
  // independent-source counting.
  const v = hasFiling ? { status: 'VERIFIED', mult: 1.0 } : verify(distinctSources);

  // Red flag: a confident bearish/negative event -> can hard-reject the stock.
  if (stars < 0 && confidence >= 60) {
    return { ...empty, negative: true, type, confidence, impact, stars, verification: v.status, sources: distinctSources, summary: classification.summary || null };
  }
  // Gate: only a real, fresh, confident, high-impact bullish catalyst earns points. UNVERIFIED
  // (single-source) catalysts are down-weighted hard so they can't drive a pick on their own.
  const base = { type, confidence, impact, stars, freshness, verification: v.status, sources: distinctSources, summary: classification.summary || null };
  if (!bullish || stars <= 1 || confidence < 80 || impact < 7 || freshness === 0) {
    return { ...empty, ...base };
  }
  const points = Math.round((stars / 5) * 40 * freshness * v.mult); // 0-40, verification-scaled
  // "Has a usable catalyst" requires it not be UNVERIFIED — the directive says single-source
  // rumours must not affect ranking.
  return { points, hasCatalyst: v.status !== 'UNVERIFIED' && points > 0, negative: false, ...base };
}

// One-shot: fetch news → inject official filings → classify → score for a single stock.
// `filings` = [{subject, date}] from the NSE snapshot; a fresh filing is authoritative and
// makes the catalyst VERIFIED (the strongest tier — no cross-source guessing needed).
export async function assessCatalyst(company, base, apiKey, keys = {}, filings = []) {
  const news = await fetchArticles(company, base, keys);
  const filingArticles = (filings || [])
    .map(f => ({ title: '[OFFICIAL NSE FILING] ' + (f.subject || ''), url: '', publishedAt: f.date ? Date.parse(String(f.date).replace(' ', 'T')) : Date.now(), source: 'nse-filing' }))
    .filter(a => a.title && isFinite(a.publishedAt) && hoursAgo(a.publishedAt) <= MAX_AGE_H);
  const articles = [...filingArticles, ...news]; // filings first (highest priority)
  const classification = await classifyCatalyst(company, articles, apiKey);
  const scored = scoreCatalyst(classification, articles);
  return { ...scored, articleCount: articles.length, hasFiling: filingArticles.length > 0 };
}
