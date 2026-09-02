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

import { parseNseDateMs } from './_nse-date.js';

const MAX_AGE_H = 72;      // hard limit on how old a NEWS article we'll even fetch (source cutoff)
const FRESH_H = 48;        // <48h = full weight (legacy bucket constant, retained for reference)

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

// PRIORITY 6 — CATALYST PERSISTENCE. Different events keep moving a stock for very different
// spans: a government/defence order or a capacity expansion is a structural, multi-week story,
// while a broker upgrade or a generic headline is spent in days. Each type gets an INFLUENCE
// WINDOW (days); the weight decays smoothly across it (see decayWeight) instead of the old flat
// "full until 48h, then a cliff, then zero at 72h" bucketing. A catalyst therefore FADES rather
// than vanishing, and important ones stay meaningful for the days they actually matter.
export const CATALYST_INFLUENCE_DAYS = {
  'government order': 13, 'government approval': 13, 'large contract': 13, 'contract win': 13,
  'capacity expansion': 12, 'acquisition': 12,
  'regulatory approval': 11, 'debt reduction': 10,
  'promoter buying': 9, 'institution buying': 9, 'institutional buying': 9,
  'earnings beat': 6, 'results beat': 6,
  'new product': 5, 'broker upgrade': 3, 'management change': 3,
  'general news': 1.5, 'no catalyst': 1,
  // Red flags decay slowly too — a fraud/SEBI cloud lingers.
  'fraud': 20, 'sebi action': 20, 'investigation': 15, 'regulatory action': 12, 'resignation': 8,
};
const DEFAULT_INFLUENCE_DAYS = 3;

export function influenceDaysFor(type) {
  return CATALYST_INFLUENCE_DAYS[String(type || '').toLowerCase().trim()] ?? DEFAULT_INFLUENCE_DAYS;
}

// PRIORITY 8 — EVENT IMPACT WEIGHTING. Maps each event to a signed impact CLASS + a 0-1 weight
// used to scale (not replace) the catalyst's contribution. This makes the "not all verified news
// is equal" hierarchy explicit and tunable. It influences the catalyst score (and thus the
// multi-signal confidence) but never overrides momentum/technical quality — the catalyst factor
// is only 20% of the composite and confidence is an AGREEMENT measure, so a strong catalyst on a
// technically-broken stock still can't force a buy.
export const EVENT_IMPACT = {
  'government order': { class: 'very-high+', weight: 1.0 }, 'government approval': { class: 'very-high+', weight: 1.0 },
  'large contract': { class: 'very-high+', weight: 1.0 }, 'contract win': { class: 'very-high+', weight: 1.0 },
  'capacity expansion': { class: 'high+', weight: 0.85 }, 'acquisition': { class: 'high+', weight: 0.85 },
  'earnings beat': { class: 'high+', weight: 0.85 }, 'results beat': { class: 'high+', weight: 0.85 },
  'regulatory approval': { class: 'high+', weight: 0.85 },
  'promoter buying': { class: 'high+', weight: 0.8 }, 'institution buying': { class: 'high+', weight: 0.8 }, 'institutional buying': { class: 'high+', weight: 0.8 },
  'debt reduction': { class: 'medium+', weight: 0.7 },
  'broker upgrade': { class: 'medium+', weight: 0.6 }, 'new product': { class: 'medium+', weight: 0.55 },
  'management change': { class: 'low+', weight: 0.4 },
  'general news': { class: 'low+', weight: 0.3 }, 'no catalyst': { class: 'neutral', weight: 0.0 },
  'fraud': { class: 'very-high-', weight: 1.0 }, 'sebi action': { class: 'very-high-', weight: 1.0 },
  'investigation': { class: 'high-', weight: 0.85 }, 'regulatory action': { class: 'high-', weight: 0.8 }, 'resignation': { class: 'medium-', weight: 0.6 },
};
export function eventImpact(type) {
  return EVENT_IMPACT[String(type || '').toLowerCase().trim()] || { class: 'low+', weight: 0.3 };
}

// Smooth decay of a catalyst's weight with age, over its event-specific influence window.
// Half-life = window/2, so: age 0 → 1.0, age = window/2 → 0.5, age = window → 0.25, and it's
// cut to 0 once well past the window (~1.6×) so genuinely stale catalysts stop counting.
// `ageDays` is the age of the FRESHEST evidence for the catalyst; `type` selects the window.
export function decayWeight(ageDays, type) {
  if (ageDays == null || !isFinite(ageDays) || ageDays < 0) return 0;
  const window = influenceDaysFor(type);
  if (ageDays > window * 1.6) return 0;
  const halfLife = Math.max(0.5, window / 2);
  return +Math.pow(0.5, ageDays / halfLife).toFixed(3);
}

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
// PRIORITY 6: the age weight now DECAYS over the event's influence window (decayWeight) rather
// than dropping off a 72h cliff. PRIORITY 8: the event's impact weight (eventImpact) scales the
// score, so a government order counts for more than a broker upgrade even at equal freshness.
export function scoreCatalyst(classification, articles) {
  const empty = { points: 0, hasCatalyst: false, negative: false, type: 'no catalyst', confidence: 0, impact: 0, stars: 0, freshness: 0, decay: 0, impactClass: 'neutral', influenceDays: 0, ageDays: null, verification: 'UNVERIFIED', sources: 0, summary: null };
  if (!classification) return empty;
  const type = String(classification.catalyst_type || '').toLowerCase().trim();
  const stars = CATALYST_STARS[type] ?? 1;
  const bullish = String(classification.direction || '').toLowerCase().includes('bull');
  const confidence = Math.max(0, Math.min(100, Number(classification.confidence) || 0));
  const impact = Math.max(0, Math.min(10, Number(classification.impact_score) || 0));
  const newestAgeH = articles.length ? hoursAgo(Math.max(...articles.map(a => a.publishedAt))) : null;
  const ageDays = newestAgeH != null ? +(newestAgeH / 24).toFixed(2) : null;
  const decay = decayWeight(ageDays, type);          // PRIORITY 6: per-type time decay
  const imp = eventImpact(type);                      // PRIORITY 8: signed impact class + weight
  const influenceDays = influenceDaysFor(type);
  const distinctSources = new Set((articles || []).map(a => a.source)).size;
  const hasFiling = (articles || []).some(a => a.source === 'nse-filing');
  // An official NSE filing IS verification (strongest tier); otherwise fall back to
  // independent-source counting.
  const v = hasFiling ? { status: 'VERIFIED', mult: 1.0 } : verify(distinctSources);

  // `freshness` retained in the return (== decay now) for backward compatibility with any reader.
  const base = { type, confidence, impact, stars, freshness: decay, decay, impactClass: imp.class, influenceDays, ageDays, verification: v.status, sources: distinctSources, summary: classification.summary || null };

  // Red flag: a confident bearish/negative event -> can hard-reject the stock.
  if (stars < 0 && confidence >= 60) {
    return { ...empty, ...base, negative: true };
  }
  // Gate: only a real, still-influential, confident, high-impact bullish catalyst earns points.
  if (!bullish || stars <= 1 || confidence < 80 || impact < 7 || decay === 0) {
    return { ...empty, ...base };
  }
  // 0-40, scaled by verification, time-decay AND event impact weight (Priority 8).
  const points = Math.round((stars / 5) * 40 * decay * v.mult * imp.weight);
  // "Has a usable catalyst" requires VERIFIED specifically (2+ independent sources, or an
  // official NSE filing) — a single-source (PARTIAL) headline is not enough to act on. This
  // matches how small-cap momentum traders operate in practice: every headline must be
  // corroborated by at least one other trusted source, or the primary filing, before it's
  // treated as real. PARTIAL still scores (so it's visible in diagnostics) but can no longer
  // drive a trade on its own.
  return { points, hasCatalyst: v.status === 'VERIFIED' && points > 0, negative: false, ...base };
}

// One-shot: fetch news → inject official filings → classify → score for a single stock.
// `filings` = [{subject, date}] from the NSE snapshot; a fresh filing is authoritative and
// makes the catalyst VERIFIED (the strongest tier — no cross-source guessing needed).
export async function assessCatalyst(company, base, apiKey, keys = {}, filings = []) {
  const news = await fetchArticles(company, base, keys);
  const filingArticles = (filings || [])
    .map(f => ({ title: '[OFFICIAL NSE FILING] ' + (f.subject || ''), url: '', publishedAt: f.date ? parseNseDateMs(f.date) : Date.now(), source: 'nse-filing' }))
    .filter(a => a.title && isFinite(a.publishedAt) && hoursAgo(a.publishedAt) <= MAX_AGE_H);
  const articles = [...filingArticles, ...news]; // filings first (highest priority)
  const classification = await classifyCatalyst(company, articles, apiKey);
  const scored = scoreCatalyst(classification, articles);
  return { ...scored, articleCount: articles.length, hasFiling: filingArticles.length > 0 };
}

// ---- PRIORITY 6: CATALYST MEMORY (multi-day persistence) ----
// The news APIs only surface the last ~72h, and the NSE filing window is ~3 days — so without
// memory a genuine 2-week catalyst (a defence order, a big capacity expansion) would silently
// vanish from the engine's view after a few days even though it's still moving the stock. These
// pure helpers let the buy-scan persist a VERIFIED catalyst the day it's found and RECALL it on
// later scans/days with a decayed weight, so important catalysts fade over their real influence
// window instead of disappearing. Store shape: { catalysts: { TICKER: {…} } }.

// Write/refresh a memory entry from a freshly scored, VERIFIED catalyst. Returns the entry.
export function rememberCatalyst(scored, nowMs = Date.now()) {
  if (!scored || !scored.hasCatalyst || scored.verification !== 'VERIFIED') return null;
  return {
    type: scored.type, stars: scored.stars, verification: 'VERIFIED',
    impactClass: scored.impactClass, summary: scored.summary || null,
    firstSeenMs: nowMs, lastConfirmedMs: nowMs,
  };
}

// Recall a remembered catalyst as a scored-shaped object with a DECAYED weight, or null if it's
// missing / past its influence window. `mem` is the stored entry; age is measured from when the
// catalyst was last confirmed. Recalled catalysts are marked recalled:true and never re-verify —
// they inherit the VERIFIED status they earned when first detected.
export function recallCatalyst(mem, nowMs = Date.now()) {
  if (!mem || mem.verification !== 'VERIFIED') return null;
  const ageDays = (nowMs - (mem.lastConfirmedMs || mem.firstSeenMs || nowMs)) / 86400000;
  const decay = decayWeight(ageDays, mem.type);
  if (decay <= 0) return null; // fully faded — forget it
  const imp = eventImpact(mem.type);
  const stars = mem.stars ?? (CATALYST_STARS[String(mem.type || '').toLowerCase().trim()] ?? 1);
  const points = Math.round((stars / 5) * 40 * decay * imp.weight);
  if (points <= 0) return null;
  return {
    points, hasCatalyst: true, negative: false, recalled: true,
    type: mem.type, stars, confidence: 80, impact: 7,
    freshness: decay, decay, impactClass: imp.class,
    influenceDays: influenceDaysFor(mem.type), ageDays: +ageDays.toFixed(2),
    verification: 'VERIFIED', sources: 1, summary: mem.summary || null,
    articleCount: 0, hasFiling: false,
  };
}

// Drop fully-faded entries so the memory file stays small. Returns a new {catalysts} object.
export function pruneCatalystMemory(memory, nowMs = Date.now()) {
  const out = {};
  for (const [sym, mem] of Object.entries(memory?.catalysts || {})) {
    const ageDays = (nowMs - (mem.lastConfirmedMs || mem.firstSeenMs || nowMs)) / 86400000;
    if (decayWeight(ageDays, mem.type) > 0) out[sym] = mem;
  }
  return { catalysts: out };
}
