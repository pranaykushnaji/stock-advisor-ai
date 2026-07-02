// Stock of the Day — picks best stock daily from LIVE-discovered candidates.
// Storage = GitHub repo files. Requires GITHUB_TOKEN env var.
import { discoverCandidates } from './_discover.js';

const REPO = 'pranaykushnaji/stock-advisor-ai';

function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

// Map company names / tickers to Yahoo NSE symbols
const SYMBOL_MAP = {
  'RELIANCE INDUSTRIES':'RELIANCE.NS','TCS':'TCS.NS','HDFC BANK':'HDFCBANK.NS',
  'INFOSYS':'INFY.NS','ICICI BANK':'ICICIBANK.NS','BHARTI AIRTEL':'BHARTIARTL.NS',
  'LARSEN & TOUBRO':'LT.NS','STATE BANK OF INDIA':'SBIN.NS','AXIS BANK':'AXISBANK.NS',
  'KOTAK MAHINDRA BANK':'KOTAKBANK.NS','HINDUSTAN UNILEVER':'HINDUNILVR.NS','ITC':'ITC.NS',
  'BAJAJ FINANCE':'BAJFINANCE.NS','MARUTI SUZUKI':'MARUTI.NS','SUN PHARMA':'SUNPHARMA.NS',
  'TATA MOTORS':'TATAMOTORS.NS','NTPC':'NTPC.NS','POWER GRID':'POWERGRID.NS',
  'ULTRATECH CEMENT':'ULTRACEMCO.NS','ASIAN PAINTS':'ASIANPAINT.NS','TITAN':'TITAN.NS',
  'WIPRO':'WIPRO.NS','ADANI PORTS':'ADANIPORTS.NS','COAL INDIA':'COALINDIA.NS',
  'JSW STEEL':'JSWSTEEL.NS','TATA STEEL':'TATASTEEL.NS','MAHINDRA & MAHINDRA':'M&M.NS',
  'NESTLE INDIA':'NESTLEIND.NS','BAJAJ AUTO':'BAJAJ-AUTO.NS','HINDALCO':'HINDALCO.NS',
  'ZOMATO':'ZOMATO.NS','DMART':'DMART.NS','AVENUE SUPERMARTS':'DMART.NS'
};

// Fetch with a hard timeout so a hanging source can't blow the serverless limit
async function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Fetch live price from Yahoo — tries mapped symbol, then NSE/BSE suffixes.
// Also returns 1y of close prices for factor computation.
async function fetchPrice(ticker, fullName) {
  const upper = (ticker || '').toUpperCase();
  const nameUpper = (fullName || '').toUpperCase().replace(/ LTD\.?| LIMITED/g, '').trim();
  const mapped = SYMBOL_MAP[upper] || SYMBOL_MAP[nameUpper];
  const clean = upper.replace(/[^A-Z0-9.&]/g, '');
  const trySymbols = [mapped, clean.includes('.') ? clean : clean + '.NS', clean + '.BO', clean].filter(Boolean);
  for (const sym of trySymbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
      const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
      if (!r.ok) continue;
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      const meta = result?.meta;
      if (meta?.regularMarketPrice) {
        return {
          price: +meta.regularMarketPrice.toFixed(2),
          open: meta.regularMarketOpen ? +meta.regularMarketOpen.toFixed(2) : null,
          prevClose: (meta.chartPreviousClose ?? meta.previousClose) ? +(meta.chartPreviousClose ?? meta.previousClose).toFixed(2) : null,
          symbol: meta.symbol, currency: meta.currency,
          marketState: meta.marketState || null,
          closes: (result?.indicators?.quote?.[0]?.close || []).filter(v => v != null)
        };
      }
    } catch (e) { continue; }
  }
  // Fallback: Alpha Vantage (reliable from datacenter IPs) when Yahoo 403s
  return await fetchPriceAV(clean);
}

// Alpha Vantage fallback — free key in ALPHAVANTAGE_KEY. Daily OHLC, oldest→newest.
async function fetchPriceAV(base) {
  const apiKey = process.env.ALPHAVANTAGE_KEY;
  if (!apiKey) return null;
  const trySymbols = [`${base}.BSE`, base];
  for (const sym of trySymbols) {
    try {
      const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(sym)}&outputsize=full&apikey=${apiKey}`;
      const r = await fetchWithTimeout(url, {}, 8000);
      if (!r.ok) continue;
      const d = await r.json();
      const series = d?.['Time Series (Daily)'];
      if (!series || typeof series !== 'object') continue;
      const dates = Object.keys(series).sort();
      if (dates.length < 40) continue;
      const recent = dates.slice(-260);
      const closes = recent.map(dt => parseFloat(series[dt]['4. close'])).filter(v => v != null && !isNaN(v));
      const last = closes[closes.length - 1];
      const prev = closes.length > 1 ? closes[closes.length - 2] : last;
      // AV daily has no intraday open/marketState; treat as end-of-day close data
      return {
        price: +last.toFixed(2), open: null,
        prevClose: +prev.toFixed(2), symbol: sym, currency: 'INR',
        marketState: 'CLOSED', closes
      };
    } catch (e) { continue; }
  }
  return null;
}

// --- Factor math (mirror of frontend factors) ---
function periodReturn(closes, lb, skip) {
  if (!closes || closes.length < lb + skip + 1) return null;
  const end = closes.length - 1 - skip, start = end - lb;
  if (start < 0 || end <= start) return null;
  const p0 = closes[start], p1 = closes[end];
  if (!p0 || !p1 || p0 <= 0) return null;
  return ((p1 - p0) / p0) * 100;
}
function annualizedVol(closes) {
  if (!closes || closes.length < 30) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) if (closes[i] != null && closes[i-1] > 0) rets.push((closes[i] - closes[i-1]) / closes[i-1]);
  if (rets.length < 20) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}
function computeRealFactors(closes) {
  if (!closes || closes.length < 40) return { momentum: { score: null }, lowVol: { score: null } };
  const m3 = periodReturn(closes, 63, 21), m6 = periodReturn(closes, 126, 21), m12 = periodReturn(closes, 252, 21);
  const avail = [m3, m6, m12].filter(v => v != null);
  const momRaw = avail.length ? avail.reduce((a, b) => a + b, 0) / avail.length : null;
  const vol = annualizedVol(closes);
  const scoreMom = momRaw == null ? null : Math.max(0, Math.min(100, Math.round(50 + momRaw * 1.15)));
  const scoreVol = vol == null ? null : Math.max(0, Math.min(100, Math.round(115 - vol * 2.05)));
  return {
    momentum: { score: scoreMom, raw: momRaw != null ? +momRaw.toFixed(1) : null, m3: m3 != null ? +m3.toFixed(1) : null, m6: m6 != null ? +m6.toFixed(1) : null, m12: m12 != null ? +m12.toFixed(1) : null },
    lowVol: { score: scoreVol, vol: vol != null ? +vol.toFixed(1) : null }
  };
}
const FACTOR_WEIGHTS = { momentum: 0.30, quality: 0.28, value: 0.22, lowVol: 0.20 };
function computeFactorComposite(f) {
  let t = 0, w = 0;
  for (const [k, wt] of Object.entries(FACTOR_WEIGHTS)) { const s = f[k]?.score; if (s != null && !isNaN(s)) { t += s * wt; w += wt; } }
  return w > 0 ? Math.round(t / w) : 50;
}


async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' }
  });
  if (!r.ok) return { content: null, sha: null };
  const d = await r.json();
  const content = Buffer.from(d.content, 'base64').toString('utf-8');
  return { content, sha: d.sha };
}

async function ghPutFile(path, contentObj, sha, token, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64'),
    ...(sha ? { sha } : {})
  };
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

// Write with one retry: if a 409 conflict (someone else wrote first), re-read the sha and try again.
async function ghPutWithRetry(path, buildObj, token, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await ghGetFile(path, token);
    let existingObj = null;
    try { existingObj = current.content ? JSON.parse(current.content) : null; } catch (e) {}
    const obj = buildObj(existingObj);
    if (obj === null) return true; // buildObj signals "no write needed"
    const ok = await ghPutFile(path, obj, current.sha, token, message);
    if (ok) return true;
  }
  return false;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;
  const isManual = cronSecret && req.query.key === cronSecret;
  if (cronSecret && !isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const date = todayIST();

  const existing = await ghGetFile('data/daily-pick.json', ghToken);
  if (existing.content && !req.query.force) {
    try {
      const prev = JSON.parse(existing.content);
      if (prev?.pick?.date === date) {
        return res.status(200).json({ status: 'already_picked', pick: prev.pick });
      }
    } catch (e) {}
  }

  // Discover today's candidates live (news + movers, Nifty-50 fallback)
  const { candidates, sources } = await discoverCandidates(apiKey);

  const SELECTION_PROMPT = `You are a factor-based equity strategist for Indian markets. Today is ${date}.

These candidates surfaced from TODAY's market news and top movers. Pick the SINGLE best stock to BUY, favoring strong Quality (high ROE/ROCE, low debt) and reasonable Value (not overpriced). Momentum and volatility will be measured separately from real price data, so weight fundamentals here.

Candidates: ${candidates.join(', ')}

Return ONLY valid JSON (no markdown). ALL scores 0-100 integers:
{
  "ticker": "SYMBOL", "fullName": "Full Name", "sector": "Sector",
  "estimatedUpside": "12-20%", "riskLevel": "Low/Medium/High", "horizon": "6-12 months",
  "factors": {
    "quality": {"score":0,"subScores":{"roe":0,"roce":0,"debtToEquity":0,"earningsStability":0,"margins":0},"positives":["..."],"negatives":["..."]},
    "value": {"score":0,"subScores":{"peRatio":0,"pbRatio":0,"pegRatio":0,"dividendYield":0},"positives":["..."],"negatives":["..."]}
  },
  "newsSummary": "1-2 sentences on the key catalyst that made this stand out today",
  "summary": "Why this is today's pick — quality + value thesis",
  "priceContext": "CMP, range, PE, P/B",
  "whyToday": "The single most important reason this stands out TODAY"
}
Every subScore is an integer 0-100. Return ONLY the JSON.`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: SELECTION_PROMPT },
          { role: 'user', content: `Pick the Stock of the Day for ${date}.` }
        ],
        temperature: 0.4, max_tokens: 3000
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err?.error?.message || `Groq ${r.status}` });
    }

    const data = await r.json();
    let text = data?.choices?.[0]?.message?.content || '';
    const start = text.indexOf('{');
    if (start > 0) text = text.slice(start);
    let depth = 0, end = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    let pick;
    try {
      pick = JSON.parse(end > 0 ? text.slice(0, end + 1) : text);
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse AI pick', detail: e.message });
    }
    // Validate the pick has the essential fields before committing anything
    if (!pick || !pick.ticker || !pick.factors) {
      return res.status(502).json({ error: 'AI returned an incomplete pick', got: pick?.ticker || null });
    }
    pick.date = date;
    pick.pickedAt = new Date().toISOString();
    pick.discovery = sources;
    pick.candidatePool = candidates.length;

    // Fetch price + 1y history FIRST so we can compute real factors and the composite
    const priceData = await fetchPrice(pick.ticker, pick.fullName);
    // Entry price = previous close, captured at pick time from data we already have.
    // This is rock-solid (no second fetch that could be rate-limited/403'd) and is a
    // negligible fraction off the true open — a deliberate reliability tradeoff.
    // Prefer the day's real open if it happens to be available (market already open), else prevClose.
    const marketOpen = priceData?.marketState === 'REGULAR' || priceData?.marketState === 'POST' || priceData?.marketState === 'CLOSED';
    const entryPrice = priceData ? ((marketOpen && priceData.open) ? priceData.open : (priceData.prevClose || priceData.price)) : null;
    const entryProvisional = false; // entry is locked at pick time — no capture-open needed
    const shares = entryPrice ? +(10000 / entryPrice).toFixed(3) : null;

    // Recompute LLM factor scores from sub-scores (deterministic), fold in real momentum/lowVol
    const QUALITY_SUBW = { roe: 0.25, roce: 0.25, debtToEquity: 0.20, earningsStability: 0.15, margins: 0.15 };
    const VALUE_SUBW = { peRatio: 0.35, pbRatio: 0.25, pegRatio: 0.25, dividendYield: 0.15 };
    const recomputeFactor = (f, w) => { if (!f?.subScores) return; let t = 0, s = 0; for (const [m, wt] of Object.entries(w)) { const v = f.subScores[m]; if (v != null && !isNaN(v)) { t += v * wt; s += wt; } } if (s > 0) f.score = Math.round(t / s); };
    recomputeFactor(pick.factors.quality, QUALITY_SUBW);
    recomputeFactor(pick.factors.value, VALUE_SUBW);
    const real = computeRealFactors(priceData?.closes || []);
    pick.factors.momentum = real.momentum;
    pick.factors.lowVol = real.lowVol;
    pick.composite = computeFactorComposite(pick.factors);
    pick.verdict = pick.composite >= 70 ? 'BUY' : pick.composite >= 50 ? 'HOLD' : 'AVOID';

    // Capture Nifty level at entry for alpha tracking
    let niftyAtEntry = null;
    try {
      const nr = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 4000);
      if (nr.ok) { const nm = (await nr.json())?.chart?.result?.[0]?.meta; if (nm?.regularMarketPrice) niftyAtEntry = +nm.regularMarketPrice.toFixed(2); }
    } catch (e) {}

    // Save daily pick (now complete with factors, composite, verdict) — retry-safe
    await ghPutWithRetry('data/daily-pick.json', () => ({ pick }), ghToken, `Stock of the Day: ${pick.ticker} (${date})`);

    // Append to project bouquet (retry-safe, guards against double-add for same day)
    await ghPutWithRetry('data/project-bouquet.json', (current) => {
      let bouquet = current?.bouquet || [];
      if (bouquet.find(b => b.date === date)) return null; // already added today — skip write
      bouquet.unshift({
        ticker: pick.ticker, fullName: pick.fullName, sector: pick.sector,
        verdict: pick.verdict, composite: pick.composite, date, addedAt: pick.pickedAt, investedAmount: 10000,
        entryPrice, currentPrice: priceData?.price || entryPrice, shares,
        entryPriceProvisional: entryProvisional,
        // If entry is prevClose (market wasn't open at pick time), flag it so the 5:30 PM
        // cron can UPGRADE it to today's real open once the daily candle is complete.
        entryFromPrevClose: !(marketOpen && priceData?.open),
        dayOpen: (marketOpen && priceData?.open) ? priceData.open : null, prevClose: priceData?.prevClose || null,
        todayChangePct: (priceData?.prevClose && priceData?.price) ? +(((priceData.price - priceData.prevClose) / priceData.prevClose) * 100).toFixed(2) : null,
        lastPriceUpdate: pick.pickedAt, yahooSymbol: priceData?.symbol || null,
        niftyAtEntry, niftyNow: niftyAtEntry,
        estimatedUpside: pick.estimatedUpside, riskLevel: pick.riskLevel,
        summary: pick.summary, whyToday: pick.whyToday, factors: pick.factors
      });
      if (bouquet.length > 365) bouquet = bouquet.slice(0, 365);
      return { bouquet };
    }, ghToken, `Add ${pick.ticker} to project bouquet`);

    return res.status(200).json({ status: 'picked', pick, discovery: sources, candidates });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
