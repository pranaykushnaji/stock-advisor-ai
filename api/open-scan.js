// api/open-scan.js
// OPEN SCAN (~09:25 IST) — the "act early" half of the morning-capture system. Buys ONLY from
// data/premarket-watchlist.json (built by premarket.js at 08:05 from overnight filings + strong
// unbought finishers), in the first minutes after the 09:15 open, so continuation moves are
// entered near open prices instead of the 10:00 scan's.
//
// Deliberately NARROW — the opening window is the most volatile and manipulated stretch of the
// session, so unlike the hourly scans this does no discovery and no LLM: pre-vetted names only,
// deterministic gates only, one buy max per run, and the same daily caps/dedup as the hourly
// engine. Semantic judgment already happened at 08:05 (filing classification); what's checked
// here is purely "is the market confirming it right now": gap, opening volume, accumulation.
//
// Gates per name (all from live data + the watchlist):
//   gap vs prev close in (0.5%..8%)  — moving, but not already-blown-out (8% mirrors the
//                                      engine-wide gap-up hard reject)
//   opening relVol >= lane bar       — today's volume vs 15% of the 20d average (0.15 ≈ the
//                                      share of a day's volume typically done by ~09:30)
//   catalyst lane: VERIFIED overnight filing + relVol >= 2.1 + accumulation not distribution
//   momentum lane: relVol >= 2.5 + yesterday confidence >= 68 + institutional >= 65 +
//                  bullish/neutral regime + momentum-lane daily cap free

import { marketStatus } from './_market-calendar.js';
import { classifyRegime } from './_market-regime.js';
import { institutionalAccumulationScore } from './_institutional.js';
import { concentrationCheck } from './_correlation.js';

const REPO = 'pranaykushnaji/stock-advisor-ai';
const GAP_MIN_PCT = 0.5, GAP_MAX_PCT = 8;
const OPEN_SESSION_FRAC = 0.15;         // typical share of daily volume done by ~09:30
const CAT_RELVOL_MIN = 2.1, MOM_RELVOL_MIN = 2.5;
const MOM_MIN_YCONF = 68, MOM_MIN_INST = 65;
const MAX_NEW_BUYS_PER_DAY = 3, MOM_MAX_PER_DAY = 1;

async function fetchWithTimeout(url, opts = {}, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' },
  });
  if (!r.ok) return { content: null, sha: null };
  const d = await r.json();
  return { content: Buffer.from(d.content, 'base64').toString('utf-8'), sha: d.sha };
}
async function ghPutWithRetry(path, buildObj, token, message, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const cur = await ghGetFile(path, token);
    let existing = null;
    try { existing = cur.content ? JSON.parse(cur.content) : null; } catch (e) {}
    const obj = buildObj(existing);
    if (obj === null) return true;
    const body = { message, content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64'), ...(cur.sha ? { sha: cur.sha } : {}) };
    const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method: 'PUT', headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.ok) return true;
  }
  return false;
}
function todayIST() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
function hhmmIST() { const d = new Date(Date.now() + 5.5 * 3600 * 1000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }

// One Yahoo fetch per name: live price + prev close + today's cumulative volume + daily history
// for the 20d volume average and the institutional accumulation score.
async function fetchLiveDaily(base) {
  for (const sym of [`${base}.NS`, `${base}.BO`]) {
    try {
      const r = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 7000);
      if (!r.ok) continue;
      const result = (await r.json())?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta?.regularMarketPrice) continue;
      if (meta.currency && meta.currency !== 'INR') continue;
      const q = result.indicators?.quote?.[0] || {};
      const closes = (q.close || []).filter(v => v != null && !isNaN(v));
      const vols = (q.volume || []).filter(v => v != null && !isNaN(v));
      const todayVol = vols.length ? vols[vols.length - 1] : null;         // partial (live) bar
      const avg20 = vols.length >= 21 ? vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : null;
      const prevClose = meta.chartPreviousClose ?? (closes.length > 1 ? closes[closes.length - 2] : null);
      return { symbol: meta.symbol, price: +meta.regularMarketPrice.toFixed(2), prevClose, todayVol, avg20, closes, vols };
    } catch (e) { continue; }
  }
  return null;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.key;
  if (cronSecret && provided !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });

  const mkt = marketStatus();
  if (!mkt.open && req.query.force !== 'true') return res.status(200).json({ status: 'skipped', reason: mkt.reason });
  // Only meaningful in the opening window — outside it the hourly scans own the flow.
  const now = hhmmIST();
  if ((now < '09:16' || now > '10:00') && req.query.force !== 'true') {
    return res.status(200).json({ status: 'skipped', reason: `outside opening window (${now} IST)` });
  }

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });
  const date = todayIST();

  // Watchlist must be TODAY's — a stale one means premarket didn't run; do nothing.
  let watch = [];
  try {
    const f = await ghGetFile('data/premarket-watchlist.json', ghToken);
    const w = f.content ? JSON.parse(f.content) : null;
    if (w?.date === date) watch = w.watch || [];
  } catch (e) {}
  if (!watch.length) return res.status(200).json({ status: 'no_watchlist', note: 'premarket watchlist missing/stale — nothing to act on' });

  // Caps + dedup from the bouquet (shared with the hourly engine).
  let bouquetRows = [];
  try { const f = await ghGetFile('data/project-bouquet.json', ghToken); bouquetRows = f.content ? (JSON.parse(f.content).bouquet || []) : []; } catch (e) {}
  const todayRows = bouquetRows.filter(b => b.date === date);
  if (todayRows.length >= MAX_NEW_BUYS_PER_DAY) return res.status(200).json({ status: 'daily_cap_reached' });
  const momUsed = todayRows.filter(b => b.entryLane === 'momentum').length;
  // V2.1 session-scoped de-dup (intelligent re-entry): block open positions and today's
  // trades only — a fresh setup on a previously-exited name is a new, independent decision.
  const blocked = new Set(bouquetRows.filter(b => (!b.status || b.status === 'OPEN' || b.status === 'SELL_PENDING') || b.date === date).map(b => String(b.ticker).toUpperCase()));

  // Regime from the Nifty (yesterday's closes are fine at the open).
  let niftyCloses = [];
  try {
    const nr = await fetchWithTimeout('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1y&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 6000);
    if (nr.ok) niftyCloses = ((await nr.json())?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(v => v != null && !isNaN(v));
  } catch (e) {}
  const regime = classifyRegime(niftyCloses);
  const momLaneOpen = momUsed < MOM_MAX_PER_DAY && ['bullish', 'neutral'].includes(regime.regime);

  // Evaluate each watch name live.
  const evaluated = [];
  for (const w of watch) {
    const sym = String(w.ticker).toUpperCase();
    if (blocked.has(sym)) { evaluated.push({ ticker: sym, skip: 'held/recent' }); continue; }
    const live = await fetchLiveDaily(sym);
    if (!live || !live.prevClose || !live.avg20) { evaluated.push({ ticker: sym, skip: 'no data' }); continue; }
    const gapPct = +(((live.price - live.prevClose) / live.prevClose) * 100).toFixed(2);
    const relVol = live.todayVol ? +(live.todayVol / (live.avg20 * OPEN_SESSION_FRAC)).toFixed(2) : null;
    const inst = institutionalAccumulationScore(live.closes, live.vols, {});
    const hasVerified = w.catalyst && w.catalyst.verification === 'VERIFIED';
    const gapOk = gapPct >= GAP_MIN_PCT && gapPct <= GAP_MAX_PCT;
    let lane = null;
    if (gapOk && relVol != null) {
      if (hasVerified && relVol >= CAT_RELVOL_MIN && inst.score >= 50) lane = 'catalyst';
      else if (momLaneOpen && relVol >= MOM_RELVOL_MIN && (w.yBestConf ?? 0) >= MOM_MIN_YCONF && inst.score >= MOM_MIN_INST) lane = 'momentum';
    }
    evaluated.push({ ticker: sym, gapPct, relVol, inst: inst.score, yConf: w.yBestConf ?? null, catalyst: w.catalyst?.type ?? null, lane, _live: live, _w: w });
  }

  // Best qualifier: catalyst lane outranks momentum; then opening relVol. V2: a candidate
  // whose sector/theme already carries 2+ open positions is skipped (concentration guard).
  const openRows = bouquetRows.filter(b => !b.status || b.status === 'OPEN');
  const qualifiers = evaluated.filter(e => e.lane).sort((a, b) =>
    ((a.lane === 'catalyst' ? 0 : 1) - (b.lane === 'catalyst' ? 0 : 1)) || (b.relVol - a.relVol));
  const clean = (e) => ({ ticker: e.ticker, gapPct: e.gapPct, relVol: e.relVol, inst: e.inst, yConf: e.yConf, catalyst: e.catalyst, lane: e.lane, skip: e.skip });
  const eligible = qualifiers.filter(e => {
    const c = concentrationCheck(e.ticker, openRows);
    e._conc = c;
    return c.action !== 'reject';
  });
  if (!eligible.length) {
    return res.status(200).json({ status: 'no_open_entry', regime: regime.regime, evaluated: evaluated.map(clean) });
  }

  const pick = eligible[0];
  const live = pick._live, w = pick._w;
  // V2 dynamic sizing-lite: conviction ladder on yesterday's confidence (verified-filing
  // entries without a carryover confidence default to the 10k rung), momentum ×0.6,
  // halved on sector/theme overlap. Bounds ₹4k-₹18k.
  const ladder = (c) => c >= 80 ? 18000 : c >= 75 ? 15000 : c >= 70 ? 12000 : c >= 65 ? 10000 : c >= 60 ? 8000 : 6000;
  let investAmt = ladder(pick.yConf ?? 65);
  if (pick.lane === 'momentum') investAmt *= 0.6;
  investAmt *= (pick._conc?.factor ?? 1);
  investAmt = Math.max(4000, Math.min(18000, Math.round(investAmt / 500) * 500));
  const nowIso = new Date().toISOString();
  const thesis = pick.lane === 'catalyst'
    ? { type: w.catalyst?.type || 'overnight-filing', summary: w.catalyst?.summary || null, points: w.catalyst?.points || 0 }
    : { type: 'momentum-technical', summary: 'open-window continuation of a strong prior-day setup', points: 0 };
  const row = {
    ticker: pick.ticker, fullName: pick.ticker, sector: null,
    entryLane: pick.lane, openEntry: true,
    originalThesis: thesis, currentThesis: thesis,
    thesisScore: Math.min(90, 50 + (thesis.points || 0)), lastThesisUpdate: nowIso,
    concentration: pick._conc?.reason || null,
    verdict: 'BUY', composite: null, date, addedAt: nowIso, investedAmount: investAmt,
    entryPrice: live.price, currentPrice: live.price, shares: +(investAmt / live.price).toFixed(3),
    peakPrice: live.price,
    entryPriceProvisional: false, entryFromPrevClose: false,
    dayOpen: null, prevClose: live.prevClose, todayChangePct: pick.gapPct,
    lastPriceUpdate: nowIso, yahooSymbol: live.symbol,
    niftyAtEntry: niftyCloses.length ? +niftyCloses[niftyCloses.length - 1].toFixed(2) : null,
    niftyNow: niftyCloses.length ? +niftyCloses[niftyCloses.length - 1].toFixed(2) : null,
    confidence: pick.yConf, effectiveConfidence: pick.yConf, institutional: pick.inst, relVol: pick.relVol,
    regime: regime.regime,
    estimatedUpside: null, riskLevel: 'Medium',
    summary: pick.lane === 'catalyst'
      ? `Open-scan entry on a VERIFIED overnight filing (${w.catalyst?.type}): ${w.catalyst?.summary || ''} Opening volume ${pick.relVol}x normal pace, gap +${pick.gapPct}%.`
      : `Cautious open-scan momentum entry — yesterday's strong finisher (conf ${pick.yConf}) confirming at the open: volume ${pick.relVol}x pace, gap +${pick.gapPct}%, accumulation ${pick.inst}/100. Reduced size, tighter stops.`,
    whyToday: `Pre-market watchlist name confirmed in the opening window (${hhmmIST()} IST) — entered near the open instead of waiting for the 10:00 scan.`,
  };

  const wrote = await ghPutWithRetry('data/project-bouquet.json', (current) => {
    let bouquet = current?.bouquet || [];
    if (bouquet.find(b => b.ticker === row.ticker && b.date === date)) return null; // already added
    if (bouquet.filter(b => b.date === date).length >= MAX_NEW_BUYS_PER_DAY) return null;
    bouquet.unshift(row);
    if (bouquet.length > 365) bouquet = bouquet.slice(0, 365);
    return { bouquet };
  }, ghToken, `Open-scan: buy ${row.ticker} (${pick.lane} lane, ${date})`);

  await ghPutWithRetry('data/daily-pick.json', () => ({ pick: { ...row, noTrade: false, pickedAt: nowIso, pipeline: { openScan: true, watchlist: watch.length, qualifiers: qualifiers.length } } }), ghToken, `Open-scan pick: ${row.ticker} (${date})`);

  return res.status(200).json({ status: 'picked', lane: pick.lane, pick: { ticker: row.ticker, entryPrice: row.entryPrice, gapPct: pick.gapPct, relVol: pick.relVol, institutional: pick.inst, catalyst: w.catalyst?.type ?? null }, wrote, regime: regime.regime, evaluated: evaluated.map(clean) });
}
