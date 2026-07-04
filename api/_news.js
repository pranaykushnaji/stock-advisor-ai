// api/_news.js
// Unified news + sentiment for a ticker/company, combining multiple sources with
// graceful fallback. Returns a normalized sentiment signal the buy/sell engines use.
//
// Sources, in order of preference:
//   1. Finnhub company-news + sentiment (high throughput: 60/min free; US-strong, NSE thin)
//   2. NewsData.io (good India coverage; ~200/day free)
//   3. Google News RSS (no key, flaky, last resort)
//
// Returns: {
//   sentiment: number|null,   // -1..+1 merged (null if no source returned data)
//   label: 'positive'|'neutral'|'negative'|'unknown',
//   headlines: string[],      // recent headlines across sources
//   sources: { finnhub, newsdata, google },  // which returned data
//   count: number
// }

async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function todayISO(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---- Source 1: Finnhub ----
// company-news needs a US-style symbol; for NSE we try "NSE:SYMBOL" and bare symbol.
// Free tier has thin India coverage — may return []. That's fine, we fall through.
async function fromFinnhub(symbolBase, apiKey) {
  if (!apiKey) return null;
  const symbolsToTry = [`NSE:${symbolBase}`, symbolBase];
  for (const sym of symbolsToTry) {
    try {
      const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${todayISO(-7)}&to=${todayISO()}&token=${apiKey}`;
      const r = await fetchWithTimeout(url, {}, 6000);
      if (!r.ok) continue;
      const arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) continue;
      const headlines = arr.slice(0, 10).map(a => a.headline).filter(Boolean);
      // Finnhub company-news items don't carry a numeric sentiment; derive lexically below.
      if (headlines.length) return { headlines, sentiment: null, raw: arr.length };
    } catch (e) { continue; }
  }
  return null;
}

// ---- Source 2: NewsData.io ----
async function fromNewsData(query, apiKey) {
  if (!apiKey) return null;
  try {
    const url = `https://newsdata.io/api/1/news?apikey=${apiKey}&q=${encodeURIComponent(query)}&country=in&category=business&language=en`;
    const r = await fetchWithTimeout(url, {}, 6000);
    if (!r.ok) return null;
    const d = await r.json();
    const results = d?.results;
    if (!Array.isArray(results) || !results.length) return null;
    const headlines = results.slice(0, 10).map(a => a.title).filter(Boolean);
    // NewsData paid tiers include sentiment; free tier usually doesn't → derive lexically.
    const sentiments = results.map(a => a.sentiment).filter(s => typeof s === 'string');
    let sentiment = null;
    if (sentiments.length) {
      const score = sentiments.reduce((acc, s) => acc + (s === 'positive' ? 1 : s === 'negative' ? -1 : 0), 0) / sentiments.length;
      sentiment = +score.toFixed(2);
    }
    return headlines.length ? { headlines, sentiment, raw: results.length } : null;
  } catch (e) { return null; }
}

// ---- Source 3: Google News RSS (fallback) ----
async function fromGoogle(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' stock')}&hl=en-IN&gl=IN&ceid=IN:en`;
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
    if (!r.ok) return null;
    const text = await r.text();
    const headlines = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(text)) !== null && headlines.length < 10) {
      const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      if (title) headlines.push(title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
    }
    return headlines.length ? { headlines, sentiment: null, raw: headlines.length } : null;
  } catch (e) { return null; }
}

// Lightweight lexical sentiment for headlines that lack a provider score.
// Not a substitute for real NLP, but a cheap directional signal for gating.
const POS = ['surge','soar','jump','rally','gain','record','beat','upgrade','profit','strong','high','wins','bags','order','growth','rises','rise','boost','outperform','buy'];
const NEG = ['fall','drop','plunge','slump','loss','miss','downgrade','weak','cut','decline','probe','fraud','concern','warns','warning','sell','crash','slide','lawsuit','ban','recall'];
function lexicalSentiment(headlines) {
  if (!headlines || !headlines.length) return null;
  let pos = 0, neg = 0;
  for (const h of headlines) {
    const w = h.toLowerCase();
    for (const t of POS) if (w.includes(t)) pos++;
    for (const t of NEG) if (w.includes(t)) neg++;
  }
  if (pos + neg === 0) return 0; // neutral
  return +((pos - neg) / (pos + neg)).toFixed(2);
}

function labelFor(s) {
  if (s == null) return 'unknown';
  if (s > 0.15) return 'positive';
  if (s < -0.15) return 'negative';
  return 'neutral';
}

// Public: fetch merged news+sentiment for a stock.
export async function fetchNews(company, symbolBase, keys = {}) {
  const { finnhubKey, newsdataKey } = keys;
  const [fh, nd] = await Promise.all([
    fromFinnhub(symbolBase, finnhubKey),
    fromNewsData(company || symbolBase, newsdataKey),
  ]);
  let google = null;
  if (!fh && !nd) google = await fromGoogle(company || symbolBase); // only if both richer sources empty

  const headlines = [...new Set([
    ...(fh?.headlines || []), ...(nd?.headlines || []), ...(google?.headlines || []),
  ])].slice(0, 12);

  // Merge sentiment: prefer provider scores; fill gaps with lexical on the merged headlines.
  const providerScores = [fh?.sentiment, nd?.sentiment].filter(s => s != null && isFinite(s));
  let sentiment;
  if (providerScores.length) {
    sentiment = +(providerScores.reduce((a, b) => a + b, 0) / providerScores.length).toFixed(2);
  } else {
    sentiment = lexicalSentiment(headlines);
  }

  return {
    sentiment,
    label: labelFor(sentiment),
    headlines,
    sources: { finnhub: !!fh, newsdata: !!nd, google: !!google },
    count: headlines.length,
  };
}
