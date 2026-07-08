// api/analytics.js
// PRIORITY 4 + 5 — learning from what we DIDN'T trade, and measuring the LLM.
//
// The engine used to forget every stock it rejected and every pick the LLM vetoed. This endpoint
// closes that loop: it forward-evaluates each rejected candidate and each LLM veto once it's ≥5
// trading days old (max gain / max drawdown / close return), writes the outcome back so it's
// computed only once, and then aggregates the questions the spec asks:
//   • Which filters rejected future WINNERS? (opportunity cost)
//   • Which filters prevented LOSSES? (protection value)
//   • Are the confidence / relVol / catalyst bars too strict?
//   • Is the LLM veto net-positive — does it block losers, or cost winners?
//
// Read-modify-write against the repo JSON (same GitHub pattern as the other endpoints). Meant to
// be hit once daily after close (the Cloudflare Worker can call it), or manually with ?key=.
// GET-only + idempotent: safe to call repeatedly; already-evaluated rows are skipped.

const REPO = 'pranaykushnaji/stock-advisor-ai';
const EVAL_TRADING_DAYS = 5;         // forward window per the spec
const WINNER_CLOSE_PCT = 4;          // close-return above this = "would have been a winner"
const LOSER_CLOSE_PCT = -4;          // close-return below this = "correctly avoided a loss"

async function ghGetFile(path, token) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json' },
  });
  if (!r.ok) return { content: null, sha: null, status: r.status };
  const d = await r.json();
  return { content: Buffer.from(d.content, 'base64').toString('utf-8'), sha: d.sha, status: 200 };
}
async function ghPutFile(path, obj, sha, token, message) {
  const body = { message, content: Buffer.from(JSON.stringify(obj, null, 2)).toString('base64'), ...(sha ? { sha } : {}) };
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.ok;
}
async function ghPutWithRetry(path, buildObj, token, message, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const cur = await ghGetFile(path, token);
    let existing = null;
    try { existing = cur.content ? JSON.parse(cur.content) : null; } catch (e) {}
    const obj = buildObj(existing);
    if (obj === null) return true;
    if (await ghPutFile(path, obj, cur.sha, token, message)) return true;
  }
  return false;
}

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

const ALIASES = { ZOMATO: 'ETERNAL', MOTHERSUMI: 'MOTHERSON', MINDTREE: 'LTIM' };
const aliasBase = (s) => { const u = (s || '').replace(/\.(NS|BO)$/i, '').toUpperCase(); return ALIASES[u] || u; };

// Daily OHLC rows (oldest→newest) for a symbol, so we can measure the forward window.
async function fetchSeries(tickerOrSymbol) {
  const base = aliasBase(tickerOrSymbol);
  for (const sym of [tickerOrSymbol, `${base}.NS`, `${base}.BO`].filter(Boolean)) {
    try {
      const r = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 8000);
      if (!r.ok) continue;
      const result = (await r.json())?.chart?.result?.[0];
      if (!result?.timestamp) continue;
      const meta = result.meta || {};
      if (meta.currency && meta.currency !== 'INR') continue;
      const q = result.indicators?.quote?.[0] || {};
      const rows = result.timestamp.map((t, i) => ({
        date: new Date(t * 1000).toISOString().slice(0, 10),
        high: q.high?.[i], low: q.low?.[i], close: q.close?.[i],
      })).filter(x => x.close != null && !isNaN(x.close));
      if (rows.length) return rows;
    } catch (e) { continue; }
  }
  return null;
}

// Forward outcome over EVAL_TRADING_DAYS sessions AFTER the entry date, measured from entryRef.
// Returns { maxGainPct, maxDrawdownPct, closeReturnPct, days } or null if not enough forward bars.
function forwardOutcome(rows, entryDate, entryRef) {
  if (!rows || !entryRef) return null;
  const fwd = rows.filter(r => r.date > entryDate).slice(0, EVAL_TRADING_DAYS);
  if (fwd.length < EVAL_TRADING_DAYS) return null; // not matured yet
  let maxHigh = -Infinity, minLow = Infinity;
  for (const r of fwd) {
    if (r.high != null) maxHigh = Math.max(maxHigh, r.high);
    if (r.low != null) minLow = Math.min(minLow, r.low);
  }
  const lastClose = fwd[fwd.length - 1].close;
  return {
    maxGainPct: isFinite(maxHigh) ? +(((maxHigh - entryRef) / entryRef) * 100).toFixed(2) : null,
    maxDrawdownPct: isFinite(minLow) ? +(((minLow - entryRef) / entryRef) * 100).toFixed(2) : null,
    closeReturnPct: +(((lastClose - entryRef) / entryRef) * 100).toFixed(2),
    days: fwd.length,
  };
}

// Evaluate every un-evaluated, matured entry in a list of {ticker, date, entryRef, yahooSymbol}.
// Mutates each entry with .outcome and .evaluated. Returns count newly evaluated.
async function evaluateEntries(entries) {
  const pending = entries.filter(e => !e.evaluated && (e.entryRefPrice != null || e.entryRef != null));
  if (!pending.length) return 0;
  // Fetch each unique symbol once.
  const bySym = new Map();
  for (const e of pending) {
    const key = (e.yahooSymbol || e.ticker || '').toUpperCase();
    if (key && !bySym.has(key)) bySym.set(key, null);
  }
  await Promise.all([...bySym.keys()].map(async (k) => { bySym.set(k, await fetchSeries(k)); }));
  let evaluated = 0;
  for (const e of pending) {
    const key = (e.yahooSymbol || e.ticker || '').toUpperCase();
    const rows = bySym.get(key);
    const ref = e.entryRefPrice ?? e.entryRef;
    const out = forwardOutcome(rows, e.date, ref);
    if (out) { e.outcome = out; e.evaluated = true; evaluated++; }
  }
  return evaluated;
}

// ---- aggregation ----
const isWinner = (o) => o && o.closeReturnPct != null && o.closeReturnPct >= WINNER_CLOSE_PCT;
const isLoser = (o) => o && o.closeReturnPct != null && o.closeReturnPct <= LOSER_CLOSE_PCT;
const avg = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;

// Per rejection-reason breakdown: for each reason, how often the rejected name went on to WIN
// (opportunity cost) vs LOSE (protection value).
function reasonBreakdown(rejected) {
  const byReason = {};
  for (const e of rejected) {
    if (!e.evaluated || !e.outcome) continue;
    for (const reason of (e.reasons || ['unspecified'])) {
      const r = byReason[reason] || (byReason[reason] = { n: 0, futureWinners: 0, avoidedLosses: 0, avgCloseReturn: [], avgMaxGain: [] });
      r.n++;
      if (isWinner(e.outcome)) r.futureWinners++;
      if (isLoser(e.outcome)) r.avoidedLosses++;
      if (e.outcome.closeReturnPct != null) r.avgCloseReturn.push(e.outcome.closeReturnPct);
      if (e.outcome.maxGainPct != null) r.avgMaxGain.push(e.outcome.maxGainPct);
    }
  }
  for (const r of Object.values(byReason)) {
    r.avgCloseReturn = avg(r.avgCloseReturn);
    r.avgMaxGain = avg(r.avgMaxGain);
    r.missedWinnerRate = r.n ? +((r.futureWinners / r.n) * 100).toFixed(1) : null;
    r.lossPreventionRate = r.n ? +((r.avoidedLosses / r.n) * 100).toFixed(1) : null;
  }
  return byReason;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.key;
  if (cronSecret && auth !== cronSecret) return res.status(401).json({ error: 'Unauthorized' });
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  // ---- Load the two datasets ----
  let rejected = [], vetoes = [], realized = [];
  try { const f = await ghGetFile('data/rejected-candidates.json', ghToken); rejected = f.content ? (JSON.parse(f.content).rejected || []) : []; } catch (e) {}
  try { const f = await ghGetFile('data/llm-veto-log.json', ghToken); vetoes = f.content ? (JSON.parse(f.content).vetoes || []) : []; } catch (e) {}
  try { const f = await ghGetFile('data/realized.json', ghToken); realized = f.content ? (JSON.parse(f.content).trades || []) : []; } catch (e) {}

  // ---- Forward-evaluate matured entries (once), then persist outcomes ----
  const newRej = await evaluateEntries(rejected);
  const newVeto = await evaluateEntries(vetoes);
  if (newRej > 0) await ghPutWithRetry('data/rejected-candidates.json', () => ({ rejected }), ghToken, `Analytics: evaluate ${newRej} rejected candidate(s)`);
  if (newVeto > 0) await ghPutWithRetry('data/llm-veto-log.json', (ex) => ({ ...(ex || {}), vetoes }), ghToken, `Analytics: evaluate ${newVeto} LLM veto(es)`);

  // ---- P4: rejected-candidate analytics ----
  const evaluatedRej = rejected.filter(e => e.evaluated && e.outcome);
  const rejectedStats = {
    totalRejected: rejected.length,
    evaluated: evaluatedRej.length,
    pending: rejected.length - evaluatedRej.length,
    futureWinnersMissed: evaluatedRej.filter(e => isWinner(e.outcome)).length,
    lossesAvoided: evaluatedRej.filter(e => isLoser(e.outcome)).length,
    avgCloseReturnOfRejected: avg(evaluatedRej.map(e => e.outcome.closeReturnPct).filter(v => v != null)),
    byRejectionReason: reasonBreakdown(evaluatedRej),
  };

  // ---- P5: LLM performance evaluation ----
  const evaluatedVetoes = vetoes.filter(e => e.evaluated && e.outcome);
  const vetoClose = evaluatedVetoes.map(e => e.outcome.closeReturnPct).filter(v => v != null);
  const allowedClose = realized.map(t => t.realizedPnlPct).filter(v => v != null);
  const llmStats = {
    tradesAllowed: realized.length,
    allowedAvgReturn: avg(allowedClose),
    allowedMaxGain: allowedClose.length ? Math.max(...allowedClose) : null,
    allowedMaxLoss: allowedClose.length ? Math.min(...allowedClose) : null,
    tradesVetoed: vetoes.length,
    vetoedEvaluated: evaluatedVetoes.length,
    vetoedHypotheticalAvgReturn: avg(vetoClose),
    vetoedHypotheticalMaxGain: vetoClose.length ? Math.max(...vetoClose) : null,
    vetoedHypotheticalMaxLoss: vetoClose.length ? Math.min(...vetoClose) : null,
  };
  // Trust: the veto ADDS value when the trades it blocked would have underperformed the trades it
  // allowed. Positive delta = vetoes were correctly avoiding weaker outcomes → trust the LLM.
  if (llmStats.allowedAvgReturn != null && llmStats.vetoedHypotheticalAvgReturn != null) {
    llmStats.vetoValueDelta = +(llmStats.allowedAvgReturn - llmStats.vetoedHypotheticalAvgReturn).toFixed(2);
    llmStats.verdict = evaluatedVetoes.length < 5 ? 'insufficient-data'
      : llmStats.vetoValueDelta > 1 ? 'llm-adds-value (blocks weaker trades)'
      : llmStats.vetoValueDelta < -1 ? 'llm-costs-performance (blocks winners)'
      : 'neutral';
    // Recommended influence 0-1, conservative until ≥5 evaluated vetoes exist.
    llmStats.recommendedInfluence = evaluatedVetoes.length < 5 ? 1
      : +clamp(0.5 + llmStats.vetoValueDelta / 10, 0.2, 1).toFixed(2);
  } else {
    llmStats.verdict = 'insufficient-data';
    llmStats.recommendedInfluence = 1;
  }

  // Persist a compact LLM scorecard the buy-scan can read to modulate veto influence (P5).
  await ghPutWithRetry('data/llm-scorecard.json', () => ({
    updatedAt: new Date().toISOString(),
    recommendedInfluence: llmStats.recommendedInfluence,
    verdict: llmStats.verdict,
    vetoValueDelta: llmStats.vetoValueDelta ?? null,
    sample: { allowed: realized.length, vetoedEvaluated: evaluatedVetoes.length },
  }), ghToken, 'Analytics: update LLM scorecard');

  return res.status(200).json({
    status: 'ok',
    evaluatedThisRun: { rejected: newRej, vetoes: newVeto },
    rejectedAnalytics: rejectedStats,
    llmPerformance: llmStats,
    notes: [
      `Forward window = ${EVAL_TRADING_DAYS} trading days; winner ≥ +${WINNER_CLOSE_PCT}% close-return, loss ≤ ${LOSER_CLOSE_PCT}%.`,
      'Rejected/vetoed names are measured from the price at rejection time (entryRefPrice).',
      'LLM verdict/influence stay at insufficient-data until ≥5 vetoes have matured.',
    ],
  });
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
