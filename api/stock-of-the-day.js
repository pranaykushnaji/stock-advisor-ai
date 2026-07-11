// Stock BUY scan — runs HOURLY during market hours (not just once at 14:30), evaluating
// LIVE-discovered candidates every time so a genuine opportunity that emerges mid-session
// isn't missed just because it wasn't the single best name at one fixed moment. This file
// only ever OPENS new positions — selling is handled entirely by sell-check.js, which
// already runs hourly and independently; duplicating sell logic here would mean the same
// position gets reviewed twice within 10-20 minutes for no benefit.
// Storage = GitHub repo files. Requires GITHUB_TOKEN env var.
import { discoverCandidates } from './_discover.js';
import { marketStatus } from './_market-calendar.js';
import { assessCatalyst, rememberCatalyst, recallCatalyst, pruneCatalystMemory } from './_catalyst.js';
import { classifyRegimeV2, regimeGates } from './_market-regime.js';
import { sectorStrength, sectorScoreFor } from './_sector.js';
import { institutionalAccumulationScore } from './_institutional.js';
import { confidenceComponents, effectiveConfidence as combineConfidence } from './_confidence.js';
import { expectedEdge, laneStats } from './_edge.js';
import { concentrationCheck } from './_correlation.js';
import { freshStore, recordObservation, prevVolumeMap, markBought, hhmmIST } from './_intraday-store.js';
import { qualityMomentumChecks, scoreQualityMomentum,
  computeShortReturns, shortMomentum, volScaledMomentum } from './_scoring.js';
// NOTE: annualizedVol is NOT imported — this file already defines its own local
// annualizedVol() below (see ~line 157). Importing it too caused a duplicate-declaration
// SyntaxError that crashed the whole function. The local version is used instead.

const REPO = 'pranaykushnaji/stock-advisor-ai';

// Max % the captured entry price may differ from the INDEPENDENT NSE snapshot price before
// we distrust it and refuse to trade the pick (prevents phantom P&L from a bad price source).
const ENTRY_SANITY_TOLERANCE_PCT = 20;

// Don't re-pick a name we already hold or picked within this many days — stops the model
// chasing the same stock on consecutive days (the backtest showed POLYCAB picked 3x running).
const DEDUP_DAYS = 5;

// Cap on NEW positions opened per calendar day. With buy-scans now running hourly instead of
// once, an uncapped strong trending day could open far more positions than a sane paper
// portfolio should carry — this bounds that without blocking genuinely separate opportunities.
const MAX_NEW_BUYS_PER_DAY = 3;

// ---- MOMENTUM LANE (second entry path, no verified catalyst required) ----
// Motivation: strong movers (e.g. PAYTM 2026-07-10: effConf 72, institutional 90, relVol 2.7x)
// were being refused SOLELY for lacking a news-verified catalyst, even in supportive markets.
// This lane lets the engine cautiously buy pure momentum — but the bar is HIGHER everywhere
// else, so it is a substitution of evidence (volume + smart-money accumulation + multi-signal
// agreement), not a loosening:
//   • relVol >= 2.5 (vs 2.1)               • effective confidence >= regime bar + 6
//   • institutional accumulation >= 65      • bullish/neutral regimes ONLY (weak/volatile still
//   • never on a negative catalyst            require VERIFIED — regimeGates now truly bind)
//   • max 1 momentum-lane buy per day        • smaller size (₹6,000 vs ₹10,000)
//   • tighter exits via entryLane tag (see _sell-engine.js LANE_EXITS)
// Every momentum-lane trade is tagged entryLane:'momentum' end-to-end (bouquet → realized
// ledger) so analytics can measure whether this lane actually earns its keep — if it doesn't,
// we turn it off with data instead of debate.
const MOMENTUM_LANE = {
  MIN_RELVOL: 2.5,
  CONF_EXTRA: 6,            // added to the regime's minConfidence
  MIN_INSTITUTIONAL: 65,
  REGIMES: ['bullish', 'neutral'],
  MAX_PER_DAY: 1,
  SIZE_MULT: 0.6,           // momentum-lane positions run at 60% of the ladder size
};

// V2 DYNAMIC POSITION SIZING — conviction decides capital, not a flat number. The ladder maps
// the lane-relevant effective confidence to a base size; the momentum lane then takes 60% of
// it (no verified catalyst = less capital), a strong/weak expected edge nudges ±20%, and the
// concentration guard can halve it. Bounds [₹4,000, ₹18,000]; existing daily caps unchanged.
function sizeLadder(conf) {
  if (conf >= 80) return 18000;
  if (conf >= 75) return 15000;
  if (conf >= 70) return 12000;
  if (conf >= 65) return 10000;
  if (conf >= 60) return 8000;
  return 6000; // 55-59 (gates prevent anything below the regime bar reaching here)
}
function positionSize({ conf, lane, edgePct, concentrationFactor }) {
  let amt = sizeLadder(conf);
  if (lane === 'momentum') amt *= MOMENTUM_LANE.SIZE_MULT;
  if (edgePct != null) { if (edgePct >= 8) amt *= 1.2; else if (edgePct < 2) amt *= 0.8; }
  if (concentrationFactor != null) amt *= concentrationFactor;
  return Math.max(4000, Math.min(18000, Math.round(amt / 500) * 500));
}

function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

// How far into today's NSE session we are, as a 0-1 fraction (09:15-15:30 IST = 375 min).
// Buy-scans run hourly now, so "today's volume" is genuinely partial at every check except
// the last one — this fraction lets the volume-surge filter compare against how much volume
// SHOULD have traded by this point, not a full-day average, so the bar is equally hard to
// clear at 10:00 as it is at 15:00.
function sessionElapsedFraction() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const minutesSinceMidnight = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const openMin = 9 * 60 + 15, closeMin = 15 * 60 + 30;
  const frac = (minutesSinceMidnight - openMin) / (closeMin - openMin);
  return Math.max(0.15, Math.min(1, frac));
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
          name: meta.longName || meta.shortName || null, // real company name → better news queries
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

  // Reliability: this endpoint may run standalone (manual test) without the Cloudflare
  // Worker's own snapshot dispatch having just fired, so still nudge a fresh snapshot fetch
  // here too. Fire-and-forget — never block the scan on it. (The Worker's SCHEDULE is now
  // the primary driver of snapshot freshness — see cron-worker/worker.js — this is a backstop.)
  try {
    fetch('https://api.github.com/repos/pranaykushnaji/stock-advisor-ai/actions/workflows/nse-snapshot.yml/dispatches', {
      method: 'POST',
      headers: { 'Authorization': `token ${ghToken}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    }).catch(() => {});
  } catch (e) { /* best-effort */ }

  // Daily buy cap — cheap check before any of the expensive discovery/pricing/catalyst work.
  // Buy-scans run hourly now, so this is what actually bounds how many positions can open in
  // one day (replaces the old "one pick per day" gate, which no longer fits an hourly cadence).
  // Also counts today's momentum-lane buys so that lane's own 1/day cap can bind below.
  let momLaneUsedToday = 0;
  let openPositions = []; // for the concentration guard (sector/theme overlap with holdings)
  try {
    const bqCap = await ghGetFile('data/project-bouquet.json', ghToken);
    const bqCapList = bqCap.content ? (JSON.parse(bqCap.content).bouquet || []) : [];
    openPositions = bqCapList.filter(b => !b.status || b.status === 'OPEN');
    const todayRows = bqCapList.filter(b => b.date === date);
    momLaneUsedToday = todayRows.filter(b => b.entryLane === 'momentum').length;
    if (todayRows.length >= MAX_NEW_BUYS_PER_DAY && req.query.force !== 'true') {
      return res.status(200).json({ status: 'daily_cap_reached', boughtToday: todayRows.length, cap: MAX_NEW_BUYS_PER_DAY });
    }
  } catch (e) { /* if the bouquet can't be read, don't block the scan */ }

  // How far into today's session we are (0-1). Needed early so the discovery score can normalize
  // cross-scan volume acceleration and the quality filter can normalize the volume surge.
  const sessionFrac = sessionElapsedFraction();

  // PRIORITY 2/3: load the persistent INTRADAY CANDIDATE STORE (near-misses remembered across the
  // day + confidence history). PRIORITY 6: load the CATALYST MEMORY (multi-day catalyst persistence).
  // Both are best-effort — a missing/corrupt file just starts fresh.
  let intradayStore = { date, candidates: {} };
  try {
    const f = await ghGetFile('data/intraday-candidates.json', ghToken);
    intradayStore = freshStore(f.content ? JSON.parse(f.content) : null, date);
  } catch (e) { intradayStore = { date, candidates: {} }; }
  const prevVols = prevVolumeMap(intradayStore); // symbol -> {volume, frac} from the last scan

  let catalystMemory = { catalysts: {} };
  try {
    const f = await ghGetFile('data/catalyst-memory.json', ghToken);
    catalystMemory = pruneCatalystMemory(f.content ? JSON.parse(f.content) : null);
  } catch (e) { catalystMemory = { catalysts: {} }; }

  // PRIORITY 5: load the LLM scorecard so the veto's influence reflects its MEASURED track record.
  let llmScorecard = { recommendedInfluence: 1, verdict: 'insufficient-data' };
  try {
    const f = await ghGetFile('data/llm-scorecard.json', ghToken);
    if (f.content) llmScorecard = { ...llmScorecard, ...JSON.parse(f.content) };
  } catch (e) {}

  // V2: adaptive discovery weights (quarterly-optimized, versioned) + realized ledger (edge
  // probability anchoring + lane win rates). Both best-effort with safe defaults.
  let discoveryWeights = null, realizedTrades = [];
  try { const f = await ghGetFile('data/discovery-weights.json', ghToken); discoveryWeights = f.content ? JSON.parse(f.content)?.weights : null; } catch (e) {}
  try { const f = await ghGetFile('data/realized.json', ghToken); realizedTrades = f.content ? (JSON.parse(f.content).trades || []) : []; } catch (e) {}

  // V3: this morning's Claude market analysis (news-intel.json) — ADVISORY ONLY. It is injected
  // into the Groq narrative/veto prompt so the LLM judges with the day's context in mind; it
  // never touches the deterministic gates (regime/confidence/edge decide as always).
  let morningContext = null;
  try {
    const f = await ghGetFile('data/news-intel.json', ghToken);
    const ni = f.content ? JSON.parse(f.content) : null;
    const ageH = ni?.generatedAt ? (Date.now() - Date.parse(ni.generatedAt)) / 3600000 : Infinity;
    if (ageH <= 20 && ni.marketContext) morningContext = ni.marketContext;
  } catch (e) {}

  // PRIORITY 4: rejected candidates are accumulated here and flushed by persistLearning() so the
  // analytics endpoint can forward-evaluate them (did we reject a future winner?). persistLearning
  // also writes the intraday store; it runs on EVERY exit path (no-trade and buy) so the day's
  // confidence history + near-miss memory are never lost.
  const rejectedForLog = [];
  const addRejection = (ticker, stage, reasons, extra = {}) => {
    if (!ticker) return;
    rejectedForLog.push({
      id: `${date}|${String(ticker).toUpperCase()}|${hhmmIST()}`,
      date, ts: new Date().toISOString(), ticker: String(ticker).toUpperCase(),
      stage, reasons: Array.isArray(reasons) ? reasons : [reasons],
      evaluated: false, outcome: null, ...extra,
    });
  };
  const persistLearning = async () => {
    try {
      await ghPutWithRetry('data/intraday-candidates.json', () => intradayStore, ghToken, `Intraday candidates ${date} @${hhmmIST()}`);
    } catch (e) {}
    if (rejectedForLog.length) {
      try {
        await ghPutWithRetry('data/rejected-candidates.json', (existing) => {
          const db = existing && Array.isArray(existing.rejected) ? existing : { rejected: [] };
          const seen = new Set(db.rejected.map(r => r.id));
          const toAdd = rejectedForLog.filter(r => !seen.has(r.id));
          if (!toAdd.length) return null;
          db.rejected.push(...toAdd);
          if (db.rejected.length > 4000) db.rejected = db.rejected.slice(-4000);
          return db;
        }, ghToken, `Rejected-candidate analytics: +${rejectedForLog.length} (${date})`);
      } catch (e) {}
    }
    if (Object.keys(catalystMemory.catalysts || {}).length) {
      try { await ghPutWithRetry('data/catalyst-memory.json', () => catalystMemory, ghToken, `Catalyst memory (${date})`); } catch (e) {}
    }
  };

  // Discover today's candidates live — now ranked by the composite DISCOVERY SCORE (Priority 1),
  // fed the previous scan's volumes so it can see intraday volume ACCELERATION.
  // Guard: discoverCandidates catches internally, but wrap defensively so a throw
  // can never abort the pick with an unhandled 500.
  let candidates = [], sources = { news: 0, movers: 0, usedFallback: true }, discoveryMeta = new Map();
  try {
    const disc = await discoverCandidates(apiKey, { prevVolumes: prevVols, sessionFrac, discoveryWeights });
    candidates = disc.candidates || [];
    sources = disc.sources || sources;
    discoveryMeta = disc.discoveryMeta || new Map();
  } catch (e) { /* fall through to Nifty-50 below */ }
  if (!candidates.length) {
    // Absolute fallback so the cron always has something to pick from
    candidates = ['Reliance Industries','TCS','HDFC Bank','Infosys','ICICI Bank','Bharti Airtel','ITC','Larsen & Toubro','Axis Bank','Kotak Mahindra Bank'];
    sources.usedFallback = true;
  }

  // ---- QUALITY-MOMENTUM SELECTION (only high-quality momentum WITH a real catalyst) ----
  // 1) fetch prices; 2) apply the quality-momentum ALL-filter + hard rejects using real NSE
  // today-data; 3) run a news/catalyst LLM pass on the momentum leaders; 4) require BOTH
  // volume confirmation AND a high-confidence company catalyst — else "No Trade Today".
  // NO fundamentals: for 5-10 day trades, price/volume/catalyst matter, not valuation.
  const PRICE_POOL = 40;         // discovered names that get a 1y price fetch
  const CATALYST_SHORTLIST = 8;  // momentum survivors that get the (costly) catalyst pass

  // Real NSE today-data + surveillance list + corporate filings from the committed snapshot.
  const snapBySym = new Map();
  const surveillanceSet = new Set();
  const filingsBySym = new Map();
  const bulkBuySet = new Set(); // symbols with a bulk/block BUY print today (institutional signal)
  try {
    const snapFile = await ghGetFile('data/nse-snapshot.json', ghToken);
    const sd = snapFile.content ? JSON.parse(snapFile.content)?.data : null;
    for (const r of [...(sd?.universe || []), ...(sd?.topGainers || []), ...(sd?.topLosers || [])]) {
      if (r.symbol && !snapBySym.has(r.symbol)) snapBySym.set(r.symbol, r);
    }
    for (const s of (sd?.surveillance || [])) surveillanceSet.add(String(s).toUpperCase());
    for (const a of (sd?.announcements || [])) {
      const sym = String(a.symbol || '').toUpperCase();
      if (!sym) continue;
      if (!filingsBySym.has(sym)) filingsBySym.set(sym, []);
      filingsBySym.get(sym).push({ subject: a.subject, date: a.date });
    }
    for (const d of [...(sd?.bulkDeals || []), ...(sd?.blockDeals || [])]) {
      const sym = d?.symbol || d?.SYMBOL;
      const type = (d?.buySell || d?.BUY_SELL || '').toString().toUpperCase();
      if (sym && type.includes('B')) bulkBuySet.add(String(sym).toUpperCase().trim());
    }
  } catch (e) { /* snapshot missing → filter falls back to price-derived values */ }

  // Nifty 1y series → today's % change (relative-strength filter), relative-strength ranking
  // (benchCloses), and the MARKET REGIME (adaptive selectivity).
  let niftyGainPct = null, niftyCloses = null;
  try {
    const nr = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1y&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000);
    if (nr.ok) {
      const result = (await nr.json())?.chart?.result?.[0];
      const nm = result?.meta;
      if (nm?.regularMarketPrice && nm?.chartPreviousClose) niftyGainPct = (nm.regularMarketPrice - nm.chartPreviousClose) / nm.chartPreviousClose * 100;
      niftyCloses = (result?.indicators?.quote?.[0]?.close || []).filter(v => v != null && !isNaN(v));
    }
  } catch (e) {}
  // Sector strength from the day's snapshot universe (breadth + average move per sector).
  const sectorMap = sectorStrength([...snapBySym.values()]);

  // V2 REGIME: eight-factor model (trend, breadth, momentum breadth, large-cap leadership,
  // sector participation, volatility, gap environment, risk appetite) + regime confidence.
  // Computed ONCE per scan here and reused by every downstream layer.
  const regime = classifyRegimeV2(niftyCloses || [], [...snapBySym.values()], sectorMap);
  const gates = regimeGates(regime.regime);

  const pool = candidates.slice(0, PRICE_POOL);
  const priced = (await Promise.all(pool.map(async (name) => {
    try {
      const pd = await fetchPrice(name, name);
      if (!pd || !Array.isArray(pd.closes) || pd.closes.length < 20) return null;
      const ticker = (pd.symbol || name).replace(/\.(NS|BO)$/i, '').toUpperCase();
      const closes = pd.closes.filter(v => v != null && !isNaN(v));
      const volumes = (pd.volumes || []).filter(v => v != null && !isNaN(v));
      return { symbol: ticker, fullName: pd.name || name, closes, volumes, price: pd.price, _price: pd };
    } catch (e) { return null; }
  }))).filter(Boolean);

  // Quality-momentum ALL-filter + hard rejects. (sessionFrac was computed above, before discovery.)
  const passed = [], rejectedNames = [];
  for (const s of priced) {
    const snap = snapBySym.get(s.symbol) || {};
    const pChange = snap.pChange ?? (s._price?.prevClose && s._price?.price ? (s._price.price - s._price.prevClose) / s._price.prevClose * 100 : null);
    const tradedValueCr = (snap.lastPrice && snap.totalTradedVolume) ? (snap.lastPrice * snap.totalTradedVolume) / 1e7 : null; // ₹Cr
    const qm = qualityMomentumChecks(s.closes, s.volumes, {
      niftyGainPct, pChange, tradedValueCr,
      todayVolume: snap.totalTradedVolume ?? undefined,
      open: s._price?.open, prevClose: s._price?.prevClose,
      dayHigh: snap.dayHigh, dayLow: snap.dayLow,
      surveillance: surveillanceSet.has(s.symbol),
      sessionElapsedFraction: sessionFrac,
    });
    s._qm = qm; s._pChange = pChange; s._tradedValueCr = tradedValueCr;
    const rejCtx = { relVol: qm.relVol ?? null, pChange: pChange != null ? +pChange.toFixed(2) : null, sector: sectorScoreFor(s.symbol, sectorMap), entryRefPrice: s.price ?? null, yahooSymbol: s._price?.symbol || null, discoveryParts: discoveryMeta.get(s.symbol)?.discoveryParts ?? null };
    if (qm.rejects.length) { rejectedNames.push({ ticker: s.symbol, reasons: qm.rejects }); addRejection(s.symbol, 'hard-reject', qm.rejects, rejCtx); continue; }
    if (!qm.pass) { rejectedNames.push({ ticker: s.symbol, reasons: qm.failed }); addRejection(s.symbol, 'quality-filter', qm.failed, rejCtx); continue; }
    passed.push(s);
  }

  const noTrade = async (reason, extra) => {
    await persistLearning(); // flush intraday store + rejected log + catalyst memory before exit
    await ghPutWithRetry('data/daily-pick.json', () => ({ pick: { date, noTrade: true, reason, pickedAt: new Date().toISOString(), ...extra } }), ghToken, `No Trade Today (${date})`);
    return res.status(200).json({ status: 'no_trade', reason, ...extra });
  };

  if (!passed.length) return noTrade('no stock passed the quality-momentum filter', { rejected: rejectedNames.slice(0, 20) });

  // Catalyst pass on the momentum leaders among the survivors.
  const preRank = passed
    .map(s => ({ s, m: volScaledMomentum(shortMomentum(computeShortReturns(s.closes)), annualizedVol(s.closes)) }))
    .sort((a, b) => (b.m ?? -Infinity) - (a.m ?? -Infinity)).map(x => x.s);
  const catalystPool = preRank.slice(0, CATALYST_SHORTLIST);
  const newsKeys = { finnhubKey: process.env.FINNHUB_KEY, newsdataKey: process.env.NEWSDATA_KEY, alphaVantageKey: process.env.ALPHAVANTAGE_KEY, marketauxKey: process.env.MARKETAUX_KEY };
  await Promise.all(catalystPool.map(async (s) => {
    let cat;
    try { cat = await assessCatalyst(s.fullName || s.symbol, s.symbol, apiKey, newsKeys, filingsBySym.get(s.symbol) || []); }
    catch (e) { cat = { points: 0, hasCatalyst: false, negative: false }; }
    // PRIORITY 6: if fresh news found nothing usable but a VERIFIED catalyst was remembered on an
    // earlier day and is still within its influence window, fall back to the decayed memory —
    // important catalysts keep counting for the days they actually matter.
    if (!cat.hasCatalyst && !cat.negative) {
      const recalled = recallCatalyst(catalystMemory.catalysts[s.symbol]);
      if (recalled) cat = recalled;
    }
    // Remember a fresh VERIFIED catalyst so later scans/days can recall it.
    if (cat.hasCatalyst && cat.verification === 'VERIFIED' && !cat.recalled) {
      const mem = rememberCatalyst(cat);
      if (mem) {
        const prev = catalystMemory.catalysts[s.symbol];
        // Keep the original firstSeen; refresh lastConfirmed.
        catalystMemory.catalysts[s.symbol] = prev ? { ...mem, firstSeenMs: prev.firstSeenMs || mem.firstSeenMs } : mem;
      }
    }
    s._catalyst = cat;
    s.catalystPoints = cat?.points || 0;
    s.catalyst = cat || null;
    // PRIORITY 7: institutional accumulation footprint (from price/volume history + snapshot).
    const snap = snapBySym.get(s.symbol) || {};
    const todayClosingStrength = (snap.dayHigh != null && snap.dayLow != null && snap.dayHigh > snap.dayLow && s.price != null)
      ? (s.price - snap.dayLow) / (snap.dayHigh - snap.dayLow) : null;
    s._inst = institutionalAccumulationScore(s.closes, s.volumes, {
      bulkBuy: bulkBuySet.has(s.symbol), todayClosingStrength,
    });
    s.sectorScore = sectorScoreFor(s.symbol, sectorMap);
  }));

  // Score the WHOLE shortlist (not just the tradeable subset) so every near-miss gets a real
  // multi-signal confidence — that's what the intraday store records as confidence history.
  const scoredPool = scoreQualityMomentum(catalystPool, { benchCloses: niftyCloses, regimeScore: regime.score });
  const scoredBySym = new Map(scoredPool.map(r => [r.symbol, r]));

  // THE CORE RULE: tradeable only if BOTH high relative volume AND a high-confidence bullish
  // catalyst. Drop any name with a confident NEGATIVE catalyst (red flag).
  // relVol itself is already session-time-normalized (see sessionElapsedFraction / _scoring.js),
  // so this 2.1x bar means the same thing whether this run is the 10:00 or the 15:00 hourly
  // scan — "trading at 2.1x the pace it should be by this point in the session".
  const RELVOL_INTRADAY_MIN = 2.1;

  // V2 MODULAR CONFIDENCE: four independent component scores per candidate (technical, flow,
  // catalyst, liquidity), combined lane-aware — the momentum lane's confidence excludes the
  // catalyst component (zero by definition on that lane) so it isn't structurally penalized.
  // The intraday trend bonus (setup strengthening across scans) rides on top as before.
  // Everything is recorded per-scan in the intraday store, per-candidate on rejections, and on
  // the final pick/position — component-level learning data for analytics.
  const trendBonusBySym = new Map();
  for (const s of catalystPool) {
    const scored = scoredBySym.get(s.symbol);
    const relVol = s._qm?.relVol ?? null;
    const hasCat = !!s._catalyst?.hasCatalyst, neg = !!s._catalyst?.negative;
    const isTradeable = (relVol != null && relVol >= RELVOL_INTRADAY_MIN) && hasCat && !neg;
    const missing = [];
    if (!(relVol != null && relVol >= RELVOL_INTRADAY_MIN)) missing.push(`relVol ${relVol ?? 'n/a'}<${RELVOL_INTRADAY_MIN}`);
    if (!hasCat) missing.push(`catalyst ${s._catalyst?.verification || 'none'} (need VERIFIED)`);
    if (neg) missing.push(`negative catalyst (${s._catalyst?.type})`);

    s._comps = confidenceComponents({
      technical: {
        techScore: scored?.factors?.technicals, momentumRank: scored?.factors?.momentum,
        relStrengthRank: scored?.factors?.relStrength, maAlignment: scored?.indicators?.maAlignment,
        aboveEma200: s._qm?.aboveEma200, roomTo52wHighPct: s._qm?.roomTo52wHighPct,
        shortReturns: scored?.shortReturns,
      },
      flow: { relVol, volumeRank: scored?.factors?.volume, institutional: s._inst?.score, instFlags: s._inst?.flags },
      catalyst: { points: s.catalystPoints, verification: s._catalyst?.verification, impactClass: s._catalyst?.impactClass, recalled: s._catalyst?.recalled },
      liquidity: { tradedValueCr: s._tradedValueCr, price: s.price },
    });

    const entry = recordObservation(intradayStore, {
      ticker: s.symbol, fullName: s.fullName, sector: s.sector || scored?.sector,
      relVol, confidence: scored?.confidence ?? null, components: s._comps,
      discoveryScore: discoveryMeta.get(s.symbol)?.discoveryScore ?? null,
      catalystType: s._catalyst?.type ?? null, verification: s._catalyst?.verification ?? null,
      volume: (snapBySym.get(s.symbol) || {}).totalTradedVolume ?? null, sessionFrac,
      missing, passedFilter: true, tradeable: isTradeable,
    });
    const trendBonus = entry?.trendBonus ?? 0;
    trendBonusBySym.set(s.symbol, trendBonus);
    s._effConfMom = combineConfidence(s._comps, 'momentum', { regimeScore: regime.score, extras: trendBonus });
    s._effConfCat = combineConfidence(s._comps, 'catalyst', { regimeScore: regime.score, extras: trendBonus });
    s._effConf = Math.max(s._effConfMom, s._effConfCat); // provisional (lane not yet assigned)
  }

  // TWO ENTRY LANES. Lane A (catalyst): verified catalyst + volume — unchanged. Lane B
  // (momentum): no catalyst needed, but every other requirement is HIGHER (see MOMENTUM_LANE),
  // only in bullish/neutral regimes, and at most one per day. A candidate qualifying on both
  // lanes is treated as catalyst-lane (full size, standard exits).
  const momLaneOpen = momLaneUsedToday < MOMENTUM_LANE.MAX_PER_DAY && MOMENTUM_LANE.REGIMES.includes(regime.regime);
  const laneOf = (s) => {
    const relVol = s._qm?.relVol;
    if (s._catalyst?.negative) return null;                       // red flag blocks BOTH lanes
    if (relVol != null && relVol >= RELVOL_INTRADAY_MIN && s._catalyst?.hasCatalyst) return 'catalyst';
    if (momLaneOpen
      && relVol != null && relVol >= MOMENTUM_LANE.MIN_RELVOL
      && (s._effConfMom ?? 0) >= gates.minConfidence + MOMENTUM_LANE.CONF_EXTRA
      && (s._inst?.score ?? 0) >= MOMENTUM_LANE.MIN_INSTITUTIONAL) return 'momentum';
    return null;
  };
  for (const s of catalystPool) {
    s._lane = laneOf(s);
    // Lock the lane-relevant confidence once the lane is known.
    if (s._lane) s._effConf = s._lane === 'momentum' ? s._effConfMom : s._effConfCat;
  }
  const tradeable = catalystPool.filter(s => s._lane);

  if (!tradeable.length) {
    // Record the near-misses as rejections so analytics can learn whether the volume/catalyst
    // bars are too strict (did any of these go on to run without us?).
    for (const s of catalystPool) {
      const scored = scoredBySym.get(s.symbol);
      addRejection(s.symbol, 'core-gate', (s._catalyst?.negative ? ['negative catalyst'] : []).concat(
        (s._qm?.relVol == null || s._qm.relVol < RELVOL_INTRADAY_MIN) ? [`relVol<${RELVOL_INTRADAY_MIN}`] : [],
        (!s._catalyst?.hasCatalyst) ? [`catalyst ${s._catalyst?.verification || 'none'}`] : []),
        { relVol: s._qm?.relVol ?? null, momentum: scored?.factors?.momentum ?? null, catalystScore: scored?.factors?.catalyst ?? null,
          confidence: scored?.confidence ?? null, effectiveConfidence: s._effConf ?? null, regime: regime.regime,
          sector: s.sectorScore ?? null, techScore: scored?.factors?.technicals ?? null,
          components: s._comps ?? null, discoveryParts: discoveryMeta.get(s.symbol)?.discoveryParts ?? null,
          institutional: s._inst?.score ?? null, entryRefPrice: s.price ?? null, yahooSymbol: s._price?.symbol || null });
    }
    return noTrade('no stock qualified on either lane (verified catalyst, or high-bar momentum)', {
      regime: regime.regime, market: regime.reason, momLaneOpen,
      considered: catalystPool.map(s => ({ ticker: s.symbol, relVol: s._qm?.relVol, confidence: scoredBySym.get(s.symbol)?.confidence, effectiveConfidence: s._effConf, institutional: s._inst?.score, catalyst: s._catalyst?.type, verification: s._catalyst?.verification, filing: s._catalyst?.hasFiling, recalled: s._catalyst?.recalled, sources: s._catalyst?.sources, articles: s._catalyst?.articleCount, negative: s._catalyst?.negative })),
    });
  }

  // V2 EXPECTED EDGE per tradeable candidate: probability from confidence/regime/catalyst/vol
  // (anchored to the lane's measured win rate), expectancy from the reward/risk model. Used as
  // the ranking tiebreak, a positive-expectancy gate, and a sizing input — and stored on every
  // trade + rejection so the edge model itself becomes auditable.
  const laneHist = { catalyst: laneStats(realizedTrades, 'catalyst'), momentum: laneStats(realizedTrades, 'momentum') };
  for (const s of tradeable) {
    const sc = scoredBySym.get(s.symbol);
    s._edge = expectedEdge({
      confidence: s._effConf, regime: regime.regime, catalystPoints: s.catalystPoints || 0,
      annualizedVolPct: sc?.annualizedVol, rewardRisk: sc?.rewardRisk,
      laneWinRate: laneHist[s._lane]?.winRate, laneSamples: laneHist[s._lane]?.samples || 0,
    });
  }

  // Rank by lane-relevant effective confidence; catalyst lane wins ties over momentum
  // (verified evidence beats inferred); expected edge breaks remaining ties.
  const ranked = tradeable
    .map(s => { const sc = scoredBySym.get(s.symbol); return { ...sc, lane: s._lane, effectiveConfidence: s._effConf ?? sc.confidence, confidenceComponents: s._comps, expectedEdge: s._edge, trendBonus: trendBonusBySym.get(s.symbol) ?? 0, institutional: s._inst?.score ?? null }; })
    .sort((a, b) => (b.effectiveConfidence - a.effectiveConfidence)
      || ((a.lane === 'catalyst' ? -1 : 0) - (b.lane === 'catalyst' ? -1 : 0))
      || ((b.expectedEdge?.edgePct ?? -99) - (a.expectedEdge?.edgePct ?? -99))
      || ((b.composite ?? -1) - (a.composite ?? -1)));

  // De-dup: skip names we already hold or picked in the last DEDUP_DAYS.
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

  // V2 CONCENTRATION GUARD: a candidate whose sector/theme already has 2+ open positions is
  // skipped entirely (next-ranked candidate gets its shot); 1 overlap halves the size later.
  const concentrationBySym = new Map(ranked.map(r => [r.symbol, concentrationCheck(r.symbol, openPositions)]));
  const concentrationOk = (r) => concentrationBySym.get(r.symbol)?.action !== 'reject';
  const winner = ranked.find(r => fresh(r) && concentrationOk(r)) || ranked.find(fresh) || ranked[0];
  const winnerConc = concentrationBySym.get(winner.symbol) || { action: 'ok', factor: 1, reason: null };
  const winnerSrc = tradeable.find(s => s.symbol === winner.symbol);
  const winnerCatalyst = winnerSrc?._catalyst || null;

  // REGIME-ADAPTIVE ENTRY GATES — the final check the directive demands: ranking #1 does not
  // justify buying. Require multi-signal confidence, asymmetric reward/risk, and (in weak or
  // volatile markets) a VERIFIED catalyst. Fail any → NO TRADE (capital preservation first).
  const rr = winner.rewardRisk?.rr ?? 0;
  const winnerConf = winner.effectiveConfidence ?? winner.confidence ?? 0;
  const winnerLane = winner.lane || 'catalyst';
  // Momentum-lane entries face a HIGHER confidence bar (regime bar + CONF_EXTRA) — the extra
  // conviction is the price of entering without a verified catalyst.
  const confBar = winnerLane === 'momentum' ? gates.minConfidence + MOMENTUM_LANE.CONF_EXTRA : gates.minConfidence;
  const gateFail = [];
  if (winnerConf < confBar) gateFail.push(`confidence ${+winnerConf.toFixed(1)} < ${confBar}${winnerLane === 'momentum' ? ' (momentum-lane bar)' : ''}`);
  if (rr < gates.minRR) gateFail.push(`reward/risk ${rr} < ${gates.minRR}`);
  if (winnerLane === 'catalyst' && gates.requireVerified && winnerCatalyst?.verification !== 'VERIFIED') gateFail.push(`catalyst ${winnerCatalyst?.verification || 'UNVERIFIED'} (need VERIFIED in ${regime.regime} market)`);
  // V2: positive-expectancy gate — a trade whose probability-weighted loss outweighs its
  // probability-weighted gain is a bad bet regardless of how good it looks on any one signal.
  if ((winner.expectedEdge?.edgePct ?? 0) <= 0) gateFail.push(`expected edge ${winner.expectedEdge?.edgePct ?? 'n/a'}% ≤ 0`);
  if (winnerConc.action === 'reject') gateFail.push(winnerConc.reason);
  if (gateFail.length) {
    addRejection(winner.symbol, 'regime-gate', gateFail, {
      momentum: winner.factors?.momentum ?? null, catalystScore: winner.factors?.catalyst ?? null,
      confidence: winner.confidence ?? null, effectiveConfidence: +winnerConf.toFixed(1), regime: regime.regime,
      sector: winner.factors?.sector ?? null, techScore: winner.factors?.technicals ?? null,
      components: winner.confidenceComponents ?? null, expectedEdge: winner.expectedEdge ?? null,
      discoveryParts: discoveryMeta.get(winner.symbol)?.discoveryParts ?? null,
      rewardRisk: winner.rewardRisk ?? null, institutional: winner.institutional ?? null,
      entryRefPrice: winnerSrc?.price ?? null, yahooSymbol: winnerSrc?._price?.symbol || null,
    });
    return noTrade(`${winner.symbol} failed ${regime.regime}-market entry gates: ${gateFail.join('; ')}`, {
      regime: regime.regime, market: regime.reason,
      candidate: { ticker: winner.symbol, confidence: winner.confidence, effectiveConfidence: +winnerConf.toFixed(1), rewardRisk: winner.rewardRisk, catalyst: winnerCatalyst?.type, verification: winnerCatalyst?.verification },
    });
  }

  try {
    const priceData = winnerSrc?._price;

    // ---- LLM writes the narrative AND gets a final veto on weak picks ----
    // The veto instruction is LANE-AWARE: a momentum-lane entry has no catalyst by design, so
    // demanding one would veto every such pick. Its veto question is instead "is this a real
    // stock-specific move, or just the index / a manipulated spike?"
    const laneRules = winnerLane === 'momentum'
      ? `ENTRY TYPE: MOMENTUM LANE — this is a deliberate technical entry with NO news catalyst required. It qualified on exceptional volume (${winnerSrc?._qm?.relVol}x normal pace), institutional accumulation (${winner.institutional}/100), and multi-signal confidence in a supportive market. CRITICAL RULE: set "noPick": true ONLY if the move looks like pure index-following (nothing stock-specific in the price/volume data), or the data suggests a manipulated/blow-off spike. Do NOT veto merely because there is no news catalyst — that is expected on this lane.`
      : `CRITICAL RULE: If this stock is only moving because of general market momentum, or you cannot point to the specific company catalyst above as a genuine reason to buy, set "noPick": true. Do NOT force a thesis on a weak pick.`;
    const NARRATIVE_PROMPT = `You are a short-term momentum trader writing a quick brief for Indian swing traders. Today is ${date}. This is a SWING TRADE (5-10 days), not buy-and-hold. Use ONLY the real data provided — do not invent numbers.

Selected: ${winner.fullName} (${winner.symbol}), sector ${winner.sector}
Scores (0-100): Momentum ${winner.factors.momentum}, Relative-strength ${winner.factors.relStrength}, Volume ${winner.factors.volume}, Catalyst ${winner.factors.catalyst}, Technicals ${winner.factors.technicals}, Sector ${winner.factors.sector}. Multi-signal confidence ${winner.confidence}, composite ${winner.composite} (${winner.verdict}).
Market regime: ${regime.reason}. Reward/risk ≈ ${winner.rewardRisk?.rr} (upside ~${winner.rewardRisk?.upsidePct}% vs downside ~${winner.rewardRisk?.downsidePct}%).
${morningContext ? `Morning market analysis (pre-open research): tone ${morningContext.tone}. ${morningContext.summary || ''} Global cues: ${morningContext.globalCues || 'n/a'}${Array.isArray(morningContext.sectorsInFocus) && morningContext.sectorsInFocus.length ? ' Sectors in focus: ' + morningContext.sectorsInFocus.map(s => `${s.sector} (${s.direction})`).join(', ') + '.' : ''}` : ''}
Short-term returns (r1d/r1w/r1m): ${JSON.stringify(winner.shortReturns)}
Relative volume (today vs 20-day avg): ${winnerSrc?._qm?.relVol}x · Relative strength vs Nifty: ${winner.relStrength}
Catalyst: ${winnerCatalyst ? `${winnerCatalyst.type} — ${winnerCatalyst.verification} (${winnerCatalyst.sources} src, confidence ${winnerCatalyst.confidence}, impact ${winnerCatalyst.impact}/10) — ${winnerCatalyst.summary}` : 'none identified'}

${laneRules}

Return ONLY valid JSON (no markdown):
{
  "noPick": false,
  "estimatedUpside": "e.g. 5-8%",
  "riskLevel": "Low" | "Medium" | "High",
  "horizon": "5-10 days",
  "momentumNotes": {"positives":["ref a real metric"],"negatives":["ref a risk"]},
  "newsSummary": "1-2 sentences on the catalyst",
  "summary": "2-3 sentence swing thesis grounded in the catalyst + momentum",
  "whyToday": "the single most important reason to buy today"
}`;

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

    // PRIORITY 5: the LLM can veto a pick, but its authority is now EARNED. Every veto is logged
    // with entry-reference price so the analytics endpoint can forward-measure what the vetoed
    // pick would have done, and the scorecard's recommendedInfluence (built from that history)
    // decides whether this veto is BINDING or merely ADVISORY. Until ≥5 vetoes have matured the
    // influence stays 1 (binding); if the LLM is later shown to block winners, its influence
    // drops and a veto becomes advisory — logged, but the deterministic pick proceeds.
    const vetoInfluence = llmScorecard.recommendedInfluence ?? 1;
    const vetoBinding = vetoInfluence >= 0.5; // below 0.5 → the LLM has NOT earned a hard veto
    if (narrative?.noPick === true) {
      try {
        await ghPutWithRetry('data/llm-veto-log.json', (existing) => {
          const log = existing && Array.isArray(existing.vetoes) ? existing : { vetoes: [] };
          log.vetoes.unshift({
            id: `${date}|${winner.symbol}|${hhmmIST()}`,
            date, ticker: winner.symbol, fullName: winner.fullName,
            confidence: winner.confidence, effectiveConfidence: winner.effectiveConfidence ?? null,
            composite: winner.composite, verdict: winner.verdict,
            rewardRisk: winner.rewardRisk, regime: regime.regime,
            catalyst: winnerCatalyst?.type || null, verification: winnerCatalyst?.verification || null,
            binding: vetoBinding, influence: vetoInfluence,
            entryRefPrice: winnerSrc?._price?.price ?? null, yahooSymbol: winnerSrc?._price?.symbol || null,
            evaluated: false, outcome: null, vetoedAt: new Date().toISOString(),
          });
          if (log.vetoes.length > 300) log.vetoes = log.vetoes.slice(0, 300);
          return log;
        }, ghToken, `LLM veto log: ${winner.symbol} (${date})`);
      } catch (e) { /* logging must never block the no-trade response */ }
      if (vetoBinding) {
        addRejection(winner.symbol, 'llm-veto', ['llm: no convincing company-specific catalyst'], {
          confidence: winner.confidence ?? null, effectiveConfidence: winner.effectiveConfidence ?? null,
          regime: regime.regime, entryRefPrice: winnerSrc?._price?.price ?? null, yahooSymbol: winnerSrc?._price?.symbol || null,
        });
        return noTrade(`LLM vetoed ${winner.symbol}: no convincing company-specific catalyst`, { rejectedPick: winner.symbol });
      }
      // Advisory-only: the LLM's track record no longer justifies a hard block — proceed, but note it.
      console.warn(`[llm-veto] ${winner.symbol}: veto overridden (influence ${vetoInfluence} < 0.5, verdict ${llmScorecard.verdict})`);
      narrative.llmVetoOverridden = true;
    }

    // Assemble pick from DETERMINISTIC scores + LLM narrative
    const pick = {
      ticker: winner.symbol, fullName: winner.fullName, sector: winner.sector,
      strategy: 'quality-momentum',
      entryLane: winnerLane, // 'catalyst' | 'momentum' — drives sizing, exits, and analytics
      factors: {
        momentum: { score: winner.factors.momentum, positives: narrative?.momentumNotes?.positives || [], negatives: narrative?.momentumNotes?.negatives || [] },
        relStrength: { score: winner.factors.relStrength },
        volume: { score: winner.factors.volume },
        catalyst: { score: winner.factors.catalyst },
        technicals: { score: winner.factors.technicals },
        sector: { score: winner.factors.sector },
      },
      shortReturns: winner.shortReturns,
      volumeRatio: winner.volumeRatio,
      relVol: winnerSrc?._qm?.relVol ?? null,
      relStrength: winner.relStrength,
      catalyst: winnerCatalyst ? { type: winnerCatalyst.type, confidence: winnerCatalyst.confidence, impact: winnerCatalyst.impact, stars: winnerCatalyst.stars, points: winnerCatalyst.points, verification: winnerCatalyst.verification, sources: winnerCatalyst.sources, summary: winnerCatalyst.summary, impactClass: winnerCatalyst.impactClass ?? null, decay: winnerCatalyst.decay ?? null, influenceDays: winnerCatalyst.influenceDays ?? null, recalled: !!winnerCatalyst.recalled } : null,
      confidence: winner.confidence,
      effectiveConfidence: winner.effectiveConfidence ?? winner.confidence,
      confidenceComponents: winner.confidenceComponents ?? null, // v2: {technical,flow,catalyst,liquidity}
      expectedEdge: winner.expectedEdge ?? null,                  // v2: {expectedGainPct,expectedLossPct,probability,edgePct}
      confidenceTrend: intradayStore.candidates[winner.symbol]?.confidenceTrend ?? null,
      trendBonus: winner.trendBonus ?? 0,
      institutional: winner.institutional ?? (winnerSrc?._inst?.score ?? null),
      institutionalFlags: winnerSrc?._inst?.flags ?? [],
      discoveryScore: discoveryMeta.get(winner.symbol)?.discoveryScore ?? null,
      discoveryReasons: discoveryMeta.get(winner.symbol)?.discoveryReasons ?? [],
      concentration: winnerConc.reason || null,                   // v2: sizing note when overlapped
      llmVetoOverridden: !!narrative.llmVetoOverridden,
      rewardRisk: winner.rewardRisk,
      regime: regime.regime, market: regime.reason,
      regimeConfidence: regime.regimeConfidence ?? null, regimeFactors: regime.factors ?? null, // v2
      annualizedVol: winner.annualizedVol,
      composite: winner.composite,
      verdict: winner.verdict,
      estimatedUpside: narrative?.estimatedUpside || null,
      riskLevel: narrative?.riskLevel || null,
      horizon: narrative?.horizon || '5-10 days',
      newsSummary: narrative?.newsSummary || winnerCatalyst?.summary || null,
      summary: narrative?.summary || null,
      whyToday: narrative?.whyToday || null,
    };
    pick.date = date;
    pick.pickedAt = new Date().toISOString();
    pick.discovery = sources;
    pick.candidatePool = passed.length;
    pick.pipeline = { priced: priced.length, passedFilter: passed.length, catalystChecked: catalystPool.length, tradeable: tradeable.length };
    pick.runnerUp = ranked[1] ? { ticker: ranked[1].symbol, composite: ranked[1].composite } : null;

    // Entry price = the ACTUAL market price at signal time (14:30 IST), not the day's 9:15
    // open. Using the day's open would silently give every pick a "free" head start equal to
    // whatever the stock already moved before the signal fired — that's lookahead bias, not a
    // realistic fill. This is the price you could actually transact at right now.
    const entryPrice = priceData ? (priceData.price ?? priceData.prevClose) : null;
    const entryProvisional = false; // entry is locked at pick time — no capture-open needed
    // V2 DYNAMIC SIZING: conviction ladder (55→₹6k … 80+→₹18k) on the lane-relevant
    // confidence, ×0.6 on the momentum lane, ±20% from expected edge, halved on sector/theme
    // overlap. Bounds ₹4k-₹18k; daily caps unchanged.
    const investAmt = positionSize({ conf: winnerConf, lane: winnerLane, edgePct: winner.expectedEdge?.edgePct, concentrationFactor: winnerConc.factor });
    const shares = entryPrice ? +(investAmt / entryPrice).toFixed(3) : null;

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
      // V2 THESIS SEED: every position records WHY it was bought; sell-check keeps the thesis
      // current from new filings (stronger thesis → longer rope; broken thesis → exit).
      const thesis = winnerCatalyst?.hasCatalyst
        ? { type: winnerCatalyst.type, summary: winnerCatalyst.summary || null, points: winnerCatalyst.points || 0 }
        : { type: 'momentum-technical', summary: 'volume + accumulation momentum entry (no news catalyst)', points: 0 };
      bouquet.unshift({
        ticker: pick.ticker, fullName: pick.fullName, sector: pick.sector,
        entryLane: winnerLane, // momentum-lane positions get tighter exits in _sell-engine.js
        confidenceComponents: pick.confidenceComponents, expectedEdge: pick.expectedEdge, // v2 learning data
        originalThesis: thesis, currentThesis: thesis,
        thesisScore: Math.min(90, 50 + (thesis.points || 0)), lastThesisUpdate: pick.pickedAt,
        verdict: pick.verdict, composite: pick.composite, date, addedAt: pick.pickedAt, investedAmount: investAmt,
        entryPrice, currentPrice: priceData?.price ?? entryPrice, shares,
        peakPrice: Math.max(entryPrice || 0, priceData?.price ?? entryPrice ?? 0), // for the trailing stop
        entryPriceProvisional: entryProvisional,
        // Entry is now locked at the actual signal-time price — never upgraded to the day's
        // open (that upgrade was the source of the lookahead bias this fix removes).
        entryFromPrevClose: false,
        dayOpen: priceData?.open ?? null, prevClose: priceData?.prevClose || null,
        todayChangePct: (priceData?.prevClose && priceData?.price) ? +(((priceData.price - priceData.prevClose) / priceData.prevClose) * 100).toFixed(2) : null,
        lastPriceUpdate: pick.pickedAt, yahooSymbol: priceData?.symbol || null,
        niftyAtEntry, niftyNow: niftyAtEntry,
        estimatedUpside: pick.estimatedUpside, riskLevel: pick.riskLevel,
        summary: pick.summary, whyToday: pick.whyToday, factors: pick.factors
      });
      if (bouquet.length > 365) bouquet = bouquet.slice(0, 365);
      return { bouquet };
    }, ghToken, `Add ${pick.ticker} to project bouquet`);

    // Mark it bought in the intraday store (so later scans don't re-chase it), then flush the
    // intraday store + rejected log + catalyst memory. Never let persistence failure break the pick.
    if (!entryRejected) markBought(intradayStore, winner.symbol);
    await persistLearning();

    return res.status(200).json({ status: entryRejected ? 'picked_not_traded' : 'picked', entryRejected, pick, discovery: sources, candidates });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
