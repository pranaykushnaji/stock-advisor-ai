// Stock of the Day — picks best stock daily from LIVE-discovered candidates.
// Storage = GitHub repo files. Requires GITHUB_TOKEN env var.
import { discoverCandidates } from './_discover.js';
import { marketStatus } from './_market-calendar.js';
import { decideSell, markPending } from './_sell-engine.js';
import { fetchFundamentals } from './_fundamentals.js';
import { scoreUniverse, scoreMomentumUniverse,
  computeShortReturns, shortMomentum, volumeSignal, volScaledMomentum } from './_scoring.js';
// NOTE: annualizedVol is NOT imported — this file already defines its own local
// annualizedVol() below (see ~line 157). Importing it too caused a duplicate-declaration
// SyntaxError that crashed the whole function. The local version is used instead.

// The 'estimated' fundamentals shell — identical shape to _fundamentals.js's null case.
// Used for names outside the fundamentals shortlist so they score without a paid FMP call.
// source:'estimated' → isPotdEligible() returns false, so these are never auto-picked.
function estimatedFundamentals() {
  return {
    source: 'estimated',
    fields: {
      roe: null, roce: null, debtToEquity: null, netMargin: null, ebitdaMargin: null,
      earningsGrowth: null, peRatio: null, pbRatio: null, pegRatio: null,
      dividendYield: null, sector: null,
    },
    partial: true,
  };
}

// Fetch up to 8 recent Google News headlines for a held stock (for the sell LLM).
async function fetchHeadlines(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' stock')}&hl=en-IN&gl=IN&ceid=IN:en`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    let resp;
    try { resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    const text = await resp.text();
    const titles = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(text)) !== null && titles.length < 8) {
      const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      if (title) titles.push(title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
    }
    return titles;
  } catch (e) { return []; }
}

const REPO = 'pranaykushnaji/stock-advisor-ai';

// Max % the captured entry price may differ from the INDEPENDENT NSE snapshot price before
// we distrust it and refuse to trade the pick (prevents phantom P&L from a bad price source).
const ENTRY_SANITY_TOLERANCE_PCT = 20;

// Don't re-pick a name we already hold or picked within this many days — stops the model
// chasing the same stock on consecutive days (the backtest showed POLYCAB picked 3x running).
const DEDUP_DAYS = 5;

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
  'ZOMATO':'ETERNAL.NS','ETERNAL':'ETERNAL.NS','DMART':'DMART.NS','AVENUE SUPERMARTS':'DMART.NS'
};

// Ticker aliases for rebrands (LLM ticker may be stale). Applied to AV fallback.
const TICKER_ALIASES = { 'ZOMATO':'ETERNAL','MINDTREE':'LTIM','MOTHERSUMI':'MOTHERSON' };
function aliasBase(sym){const u=(sym||'').toUpperCase().replace(/\.(NS|BO|BSE)$/,'');return TICKER_ALIASES[u]||u;}

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
        // Prefer INR (NSE/BSE); skip a USD ADR unless it's the last symbol we try
        const isLast = sym === trySymbols[trySymbols.length - 1];
        if (meta.currency && meta.currency !== 'INR' && !isLast) continue;
        return {
          price: +meta.regularMarketPrice.toFixed(2),
          open: meta.regularMarketOpen ? +meta.regularMarketOpen.toFixed(2) : null,
          prevClose: (meta.chartPreviousClose ?? meta.previousClose) ? +(meta.chartPreviousClose ?? meta.previousClose).toFixed(2) : null,
          symbol: meta.symbol, currency: meta.currency,
          marketState: meta.marketState || null,
          closes: (result?.indicators?.quote?.[0]?.close || []).filter(v => v != null),
          volumes: (result?.indicators?.quote?.[0]?.volume || []).filter(v => v != null)
        };
      }
    } catch (e) { continue; }
  }
  // Fallback: Alpha Vantage (reliable from datacenter IPs) when Yahoo 403s (apply rebrand alias)
  return await fetchPriceAV(aliasBase(clean));
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
      const volumes = recent.map(dt => parseFloat(series[dt]['5. volume'])).filter(v => v != null && !isNaN(v));
      const last = closes[closes.length - 1];
      const prev = closes.length > 1 ? closes[closes.length - 2] : last;
      // AV daily has no intraday open/marketState; treat as end-of-day close data
      return {
        price: +last.toFixed(2), open: null,
        prevClose: +prev.toFixed(2), symbol: sym, currency: 'INR',
        marketState: 'CLOSED', closes, volumes
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
  closes = (closes || []).filter(v => v != null && !isNaN(v));
  if (closes.length < 30) return { momentum: { score: null }, lowVol: { score: null } };
  const skip = closes.length >= 150 ? 21 : closes.length >= 90 ? 10 : 0;
  const m3 = periodReturn(closes, 63, skip), m6 = periodReturn(closes, 126, skip), m12 = periodReturn(closes, 252, skip);
  let avail = [m3, m6, m12].filter(v => v != null);
  if (!avail.length) {
    const lb = Math.min(closes.length - 1, Math.max(20, Math.floor(closes.length * 0.6)));
    const fb = periodReturn(closes, lb, 0);
    if (fb != null) avail = [fb];
  }
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
    const obj = await buildObj(existingObj);
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

  // Skip on weekends / NSE holidays. Manual calls with ?force=true bypass (for testing).
  const mkt = marketStatus();
  if (!mkt.open && req.query.force !== 'true') {
    console.log(`[market-guard] pick skipped — market closed (${mkt.reason})`);
    return res.status(200).json({ status: 'skipped', reason: mkt.reason });
  }

  const apiKey = process.env.GROQ_API_KEY;
  const ghToken = process.env.GITHUB_TOKEN;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const date = todayIST();

  // Reliability: GitHub's scheduled Actions are flaky (free tier drops runs), so the
  // NSE snapshot may go stale. Trigger a fresh snapshot fetch from THIS reliable Vercel
  // cron via workflow_dispatch. Fire-and-forget — never block the pick on it.
  try {
    fetch('https://api.github.com/repos/pranaykushnaji/stock-advisor-ai/actions/workflows/nse-snapshot.yml/dispatches', {
      method: 'POST',
      headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    }).catch(() => {});
  } catch (e) { /* best-effort */ }

  // ---- PHASE 1: review held positions for SELL (runs before picking) ----
  // For each OPEN holding: rules gate (target/stop/max-hold) -> LLM on fresh news.
  // A SELL verdict flips it to SELL_PENDING with a provisional exit; the 5:30 PM
  // refresh cron books the real exit price and moves it to the realized ledger.
  let sellReview = { reviewed: 0, pending: 0 };
  try {
    await ghPutWithRetry('data/project-bouquet.json', async (current) => {
      const bouquet = current?.bouquet || [];
      const open = bouquet.filter(b => !b.status || b.status === 'OPEN');
      if (!open.length) return null; // nothing to review — no write
      let flipped = 0;
      for (const item of open) {
        sellReview.reviewed++;
        const headlines = await fetchHeadlines(item.fullName || item.ticker);
        // Fetch recent closes so the sell engine can detect momentum fade.
        let recentCloses = null;
        try {
          const pd = await fetchPrice(item.yahooSymbol || item.ticker, item.fullName);
          if (pd?.closes?.length) {
            recentCloses = pd.closes.filter(v => v != null && !isNaN(v));
            item.currentPrice = pd.price ?? item.currentPrice; // freshen for rules gate
          }
        } catch (e) {}
        const decision = await decideSell(item, apiKey, headlines, recentCloses);
        if (decision) {
          const idx = bouquet.indexOf(item);
          bouquet[idx] = markPending(item, decision);
          flipped++;
        }
      }
      sellReview.pending = flipped;
      return flipped > 0 ? { bouquet } : null; // only write if something changed
    }, ghToken, 'Sell review: mark SELL_PENDING positions');
  } catch (e) { /* sell review must never block the daily pick */ }

  const existing = await ghGetFile('data/daily-pick.json', ghToken);
  if (existing.content && !req.query.force) {
    try {
      const prev = JSON.parse(existing.content);
      if (prev?.pick?.date === date) {
        return res.status(200).json({ status: 'already_picked', pick: prev.pick, sellReview });
      }
    } catch (e) {}
  }

  // Discover today's candidates live (news + movers, Nifty-50 fallback).
  // Guard: discoverCandidates catches internally, but wrap defensively so a throw
  // can never abort the pick with an unhandled 500.
  let candidates = [], sources = { news: 0, movers: 0, usedFallback: true };
  try {
    const disc = await discoverCandidates(apiKey);
    candidates = disc.candidates || [];
    sources = disc.sources || sources;
  } catch (e) { /* fall through to Nifty-50 below */ }
  if (!candidates.length) {
    // Absolute fallback so the cron always has something to pick from
    candidates = ['Reliance Industries','TCS','HDFC Bank','Infosys','ICICI Bank','Bharti Airtel','ITC','Larsen & Toubro','Axis Bank','Kotak Mahindra Bank'];
    sources.usedFallback = true;
  }

  // ---- MOMENTUM-DOMINANT SELECTION (bouquet / swing-trade mode) ----
  // Short-term momentum leads (momentum weight 0.45, see MOMENTUM_WEIGHTS); quality is
  // only a junk-filter; volume confirms interest. A liquidity/penny/volatility junk
  // filter drops manipulated microcaps. Paired with the tightened sell engine
  // (8% target / -5% stop / 7-day max hold).
  //
  // V2 COST DISCIPLINE (two-phase fetch):
  //   Phase 1 — fetch 1y PRICES for a wide pool (cheap-ish: Yahoo, cached/staggered).
  //   Phase 2 — pre-rank on price+volume momentum only, then fetch FMP FUNDAMENTALS for
  //             just the top shortlist. FMP free tier is ~250 calls/day, so fetching
  //             fundamentals for the whole wide universe daily would blow the quota.
  //             Non-shortlisted names still get scored (fundamentals → 'estimated' shell,
  //             which scoreMomentumUniverse tolerates; quality is only a 15% junk-filter).
  const fmpKey = process.env.FMP_KEY;

  // Pool sizes — tunable. PRICE_POOL widened from the old hard 12; FUND_SHORTLIST bounds
  // the expensive fundamentals calls so we stay inside free tiers.
  const PRICE_POOL = 40;      // how many discovered names get a 1y price fetch
  const FUND_SHORTLIST = 12;  // how many of those (best momentum) get real fundamentals

  const pool = candidates.slice(0, PRICE_POOL);

  // Phase 1: prices only (no fundamentals yet).
  const priced = (await Promise.all(pool.map(async (name) => {
    try {
      const pd = await fetchPrice(name, name);
      if (!pd || !Array.isArray(pd.closes) || pd.closes.length < 20) return null;
      const ticker = (pd.symbol || name).replace(/\.(NS|BO)$/i, '').toUpperCase();
      const closes = pd.closes.filter(v => v != null && !isNaN(v));
      const volumes = (pd.volumes || []).filter(v => v != null && !isNaN(v));
      // Cheap price/volume momentum score for pre-ranking (no API cost).
      const sr = computeShortReturns(closes);
      const preScore = volScaledMomentum(shortMomentum(sr), annualizedVol(closes));
      const vs = volumeSignal(volumes);
      return {
        symbol: ticker,
        fullName: pd.name || name,
        closes, volumes,
        price: pd.price,
        _price: pd,
        _preScore: (preScore == null ? -Infinity : preScore),
        _volRatio: vs ? vs.ratio : 0,
      };
    } catch (e) { return null; }
  }))).filter(Boolean);

  // Phase 2: shortlist the best momentum names and fetch REAL fundamentals only for them.
  // Tie-break by volume surge so a genuine breakout beats a quiet drifter.
  const shortlist = priced
    .slice()
    .sort((a, b) => (b._preScore - a._preScore) || (b._volRatio - a._volRatio))
    .slice(0, FUND_SHORTLIST);
  const shortlistSet = new Set(shortlist.map(s => s.symbol));

  const universe = await Promise.all(priced.map(async (s) => {
    let fundamentals;
    if (shortlistSet.has(s.symbol)) {
      try { fundamentals = await fetchFundamentals(s.symbol, { fmpKey }); }
      catch (e) { fundamentals = estimatedFundamentals(); }
    } else {
      // Not in the shortlist → skip the paid fundamentals call, use an estimated shell.
      // These names are still scored & tradeable, but never POTD-picked (isPotdEligible
      // requires real fundamentals), so the daily pick stays grounded in real data.
      fundamentals = estimatedFundamentals();
    }
    return {
      symbol: s.symbol, fullName: s.fullName,
      closes: s.closes, volumes: s.volumes, price: s.price,
      fundamentals, _price: s._price,
    };
  }));

  const { ranked: rankedEligible, rejected } = scoreMomentumUniverse(universe);
  const fundCoverage = {
    universe: universe.length,
    tradeable: rankedEligible.length,
    rejectedJunk: rejected.map(r => ({ ticker: r.symbol, reasons: r.junkReasons })),
    bySource: universe.reduce((a, s) => { const k = s.fundamentals.source; a[k] = (a[k] || 0) + 1; return a; }, {}),
  };

  if (!rankedEligible.length) {
    return res.status(200).json({
      status: 'no_eligible_pick',
      reason: 'no tradeable candidate after junk filter',
      fundCoverage, sellReview,
    });
  }

  // V2 GROUNDING GUARD: the daily pick must have REAL fundamentals. With two-phase
  // fetching, non-shortlisted names carry an 'estimated' shell, so we pick the best
  // ranked name that ALSO has real fundamentals (i.e. was in the fundamentals shortlist).
  // The pre-rank is momentum-based like the final score, so the top ranked name is
  // almost always shortlisted anyway — this just guarantees it. Falls back to the top
  // ranked name only if somehow none of the ranked names have real fundamentals.
  const hasRealFund = (sym) => {
    const row = universe.find(u => u.symbol === sym);
    return row && row.fundamentals && row.fundamentals.source !== 'estimated';
  };
  // De-dup: skip names we already hold or picked in the last DEDUP_DAYS (avoids concentrating
  // into one rolling-over stock). Read the current bouquet to know what to exclude.
  const recentlyPicked = new Set();
  try {
    const bqNow = await ghGetFile('data/project-bouquet.json', ghToken);
    const list = bqNow.content ? (JSON.parse(bqNow.content).bouquet || []) : [];
    const cutoff = new Date(Date.now() - DEDUP_DAYS * 86400000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    for (const b of list) {
      if (!b.ticker) continue;
      const isOpen = !b.status || b.status === 'OPEN' || b.status === 'SELL_PENDING';
      const isRecent = b.date && b.date >= cutoff;
      if (isOpen || isRecent) recentlyPicked.add(String(b.ticker).toUpperCase());
    }
  } catch (e) { /* if the bouquet can't be read, don't block the pick */ }
  const fresh = (r) => !recentlyPicked.has(String(r.symbol).toUpperCase());

  const winner =
       rankedEligible.find(r => hasRealFund(r.symbol) && fresh(r))  // best fresh name with real fundamentals
    || rankedEligible.find(r => fresh(r))                           // else best fresh name
    || rankedEligible.find(r => hasRealFund(r.symbol))              // else all fresh names exhausted — fall back
    || rankedEligible[0];
  const winnerRow = universe.find(u => u.symbol === winner.symbol);

  try {
    const priceData = winnerRow._price;
    const realFund = winnerRow.fundamentals.fields;

    // ---- LLM writes ONLY the narrative for the already-chosen winner ----
    const NARRATIVE_PROMPT = `You are a short-term momentum trader writing a quick brief for Indian market swing traders. Today is ${date}.

This Stock of the Day was selected by a MOMENTUM model (short-term price strength + volume), NOT a long-term value model. It is a SWING TRADE, not a buy-and-hold. Explain it using ONLY the real data provided — do not invent numbers.

Selected: ${winner.fullName} (${winner.symbol}), sector ${winner.sector}
Momentum-model scores (0-100 percentile): Momentum ${winner.factors.momentum}, Quality-filter ${winner.factors.quality}, Volume ${winner.factors.volume}, Low-Vol ${winner.factors.lowVol}. Composite ${winner.composite} (${winner.verdict}).
Short-term returns: ${JSON.stringify(winner.shortReturns)} (r1d/r1w/r1m as decimals)
Volume ratio (recent/baseline): ${winner.volumeRatio}
Annualized volatility: ${winner.annualizedVol}%
Real fundamentals (context only, source ${winnerRow.fundamentals.source}): ${JSON.stringify(realFund)}

Return ONLY valid JSON (no markdown):
{
  "estimatedUpside": "short-term, e.g. 5-8%",
  "riskLevel": "Low" | "Medium" | "High",
  "horizon": "days to 1-2 weeks",
  "momentumNotes": {"positives":["ref a real short-term metric"],"negatives":["ref a risk"]},
  "newsSummary": "1-2 sentences on any recent catalyst driving the move",
  "summary": "2-3 sentence swing-trade thesis: why the short-term momentum is attractive now",
  "whyToday": "The single most important reason this has momentum today"
}
This is a short-term momentum trade. Reference only the real numbers above. Return ONLY the JSON.`;

    let narrative = {};
    try {
      const nr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'system', content: NARRATIVE_PROMPT }, { role: 'user', content: `Write the brief for ${winner.symbol}.` }],
          temperature: 0.4, max_tokens: 1500
        })
      });
      if (nr.ok) {
        const data = await nr.json();
        let text = data?.choices?.[0]?.message?.content || '';
        const s = text.indexOf('{'), e = text.lastIndexOf('}');
        try { narrative = JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : text); } catch (er) { narrative = {}; }
      }
    } catch (er) { narrative = {}; }

    // Assemble pick from DETERMINISTIC scores + LLM narrative
    const pick = {
      ticker: winner.symbol, fullName: winner.fullName, sector: winner.sector,
      strategy: 'momentum-swing',
      factors: {
        momentum: { score: winner.factors.momentum, positives: narrative?.momentumNotes?.positives || [], negatives: narrative?.momentumNotes?.negatives || [] },
        quality: { score: winner.factors.quality },
        volume: { score: winner.factors.volume },
        lowVol: { score: winner.factors.lowVol },
      },
      shortReturns: winner.shortReturns,
      volumeRatio: winner.volumeRatio,
      fundamentals: realFund,
      fundamentalsSource: winnerRow.fundamentals.source,
      annualizedVol: winner.annualizedVol,
      composite: winner.composite,
      verdict: winner.verdict,
      estimatedUpside: narrative?.estimatedUpside || null,
      riskLevel: narrative?.riskLevel || null,
      horizon: narrative?.horizon || 'days to 1-2 weeks',
      newsSummary: narrative?.newsSummary || null,
      summary: narrative?.summary || null,
      whyToday: narrative?.whyToday || null,
    };
    pick.date = date;
    pick.pickedAt = new Date().toISOString();
    pick.discovery = sources;
    pick.candidatePool = universe.length;
    pick.fundCoverage = fundCoverage;
    pick.runnerUp = rankedEligible[1] ? { ticker: rankedEligible[1].symbol, composite: rankedEligible[1].composite } : null;

    // Entry price = previous close, captured at pick time from data we already have.
    // This is rock-solid (no second fetch that could be rate-limited/403'd) and is a
    // negligible fraction off the true open — a deliberate reliability tradeoff.
    // Prefer the day's real open if it happens to be available (market already open), else prevClose.
    const marketOpen = priceData?.marketState === 'REGULAR' || priceData?.marketState === 'POST' || priceData?.marketState === 'CLOSED';
    const entryPrice = priceData ? ((marketOpen && priceData.open) ? priceData.open : (priceData.prevClose || priceData.price)) : null;
    const entryProvisional = false; // entry is locked at pick time — no capture-open needed
    const shares = entryPrice ? +(10000 / entryPrice).toFixed(3) : null;

    // ENTRY-PRICE SANITY CHECK — guard against a bad price source booking phantom P&L.
    // Cross-check the captured entry against the INDEPENDENT NSE snapshot's lastPrice for this
    // symbol; if they disagree badly, don't add the position (still record the narrative pick).
    // (PHOENIXLTD 2026-07-07: entry ₹1549 vs snapshot ₹2075 → this would have caught it.)
    let entryRejected = null;
    try {
      const snapFile = await ghGetFile('data/nse-snapshot.json', ghToken);
      const snapData = snapFile.content ? JSON.parse(snapFile.content)?.data : null;
      const rows = [...(snapData?.universe || []), ...(snapData?.topGainers || []), ...(snapData?.topLosers || [])];
      const ref = rows.find(r => r.symbol === winner.symbol)?.lastPrice;
      if (entryPrice && ref && Math.abs(entryPrice - ref) / ref > ENTRY_SANITY_TOLERANCE_PCT / 100) {
        entryRejected = `entry ₹${entryPrice} is >${ENTRY_SANITY_TOLERANCE_PCT}% off the NSE snapshot price ₹${ref} — likely a bad price source; not trading this pick today`;
        console.warn(`[entry-guard] ${winner.symbol}: ${entryRejected}`);
      }
    } catch (e) { /* snapshot missing/unparseable → skip cross-check, never block the pick */ }
    pick.entryPrice = entryPrice;
    pick.entryRejected = entryRejected;

    // (Factors, composite, verdict are already set deterministically above — do NOT recompute.)

    // Capture Nifty level at entry for alpha tracking
    let niftyAtEntry = null;
    try {
      const nr = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1d&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 4000);
      if (nr.ok) { const nm = (await nr.json())?.chart?.result?.[0]?.meta; if (nm?.regularMarketPrice) niftyAtEntry = +nm.regularMarketPrice.toFixed(2); }
    } catch (e) {}

    // Save daily pick (now complete with factors, composite, verdict) — retry-safe
    await ghPutWithRetry('data/daily-pick.json', () => ({ pick }), ghToken, `Stock of the Day: ${pick.ticker} (${date})`);

    // Append to project bouquet (retry-safe, guards against double-add for same day).
    // Skip entirely if the entry price failed the sanity check — better no trade than a
    // phantom one. The narrative pick is still saved above for visibility.
    if (!entryRejected) await ghPutWithRetry('data/project-bouquet.json', (current) => {
      let bouquet = current?.bouquet || [];
      if (bouquet.find(b => b.date === date)) return null; // already added today — skip write
      bouquet.unshift({
        ticker: pick.ticker, fullName: pick.fullName, sector: pick.sector,
        verdict: pick.verdict, composite: pick.composite, date, addedAt: pick.pickedAt, investedAmount: 10000,
        entryPrice, currentPrice: priceData?.price || entryPrice, shares,
        peakPrice: Math.max(entryPrice || 0, priceData?.price || entryPrice || 0), // for the trailing stop
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

    return res.status(200).json({ status: entryRejected ? 'picked_not_traded' : 'picked', entryRejected, pick, discovery: sources, candidates, sellReview });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
