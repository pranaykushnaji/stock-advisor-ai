// api/_intraday-store.js
// PRIORITY 2 + 3 — the persistent INTRADAY CANDIDATE STORE and CONFIDENCE EVOLUTION.
//
// The buy-scan runs hourly, but each scan used to be stateless: a stock that ALMOST qualified at
// 10:00 (say RVOL 1.7 vs the 2.1 bar) was forgotten, then rediscovered from scratch at 11:00.
// This store remembers near-miss candidates across the day so a good setup can MATURE naturally
// instead of being repeatedly rediscovered, and so we can see momentum BUILDING rather than
// judging each name on a single snapshot.
//
// Shape (data/intraday-candidates.json), reset each trading day:
// {
//   "date": "2026-07-09",
//   "candidates": {
//     "TICKER": {
//       ticker, fullName, sector,
//       firstSeen: "10:00", lastSeen: "12:00",
//       status: "watching" | "qualified" | "bought",
//       scans: [ { hhmm, ts, relVol, confidence, discoveryScore,
//                  catalystType, verification, volume, sessionFrac,
//                  missing: [ "relVol 1.7<2.1", ... ], passedFilter, tradeable } , ... ],
//       bestConfidence, confidenceTrend
//     }
//   }
// }
//
// Pure helpers here (no I/O) so the buy-scan owns the single read-modify-write against GitHub and
// this module stays deterministic + unit-testable.

// Current HH:MM in IST (matches the cron labelling used elsewhere).
export function hhmmIST(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`;
}

// Normalise a raw store object to the current day, resetting if it's stale (a new day) or empty.
export function freshStore(existing, date) {
  if (existing && existing.date === date && existing.candidates) return existing;
  return { date, candidates: {} };
}

// CONFIDENCE TREND (Priority 3): reward momentum that BUILDS over several scans, not a one-off
// spike. Given the confidence history (oldest→newest), return { slope, trend, persistence }.
//   slope       = average per-scan change in confidence (points/scan), least-squares fit.
//   persistence = number of scans this candidate has been tracked (more = more trustworthy).
//   trend       = 'rising' | 'flat' | 'falling'.
export function confidenceTrend(confidences) {
  const c = (confidences || []).filter(v => v != null && isFinite(v));
  const persistence = c.length;
  if (persistence < 2) return { slope: 0, trend: 'flat', persistence };
  // Least-squares slope over index 0..n-1.
  const n = c.length;
  const xMean = (n - 1) / 2;
  const yMean = c.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (c[i] - yMean); den += (i - xMean) ** 2; }
  const slope = den > 0 ? num / den : 0;
  const trend = slope > 1.5 ? 'rising' : slope < -1.5 ? 'falling' : 'flat';
  return { slope: +slope.toFixed(2), trend, persistence };
}

// The bonus (0..CAP points) added to a candidate's confidence for a STRENGTHENING multi-scan
// history. A stock climbing 68→73→81→89 over four scans earns the full bonus; a single-scan
// spike earns nothing (needs ≥3 scans of persistence to fully count). Deterministic + capped so
// it refines the ranking without ever dominating the underlying signals.
const TREND_BONUS_CAP = 8;
export function confidenceTrendBonus(confidences) {
  const { slope, persistence } = confidenceTrend(confidences);
  if (persistence < 2 || slope <= 0) return 0;
  const persistFactor = Math.min(1, (persistence - 1) / 2); // 2 scans→0.5, 3→1.0, 4+→1.0
  const bonus = Math.min(TREND_BONUS_CAP, slope * 1.2) * persistFactor;
  return +Math.max(0, bonus).toFixed(1);
}

// Record / update one candidate observation for this scan. Mutates `store.candidates` in place
// and returns the updated candidate entry (so the caller can read its trend bonus immediately).
//   obs = { ticker, fullName, sector, relVol, confidence, discoveryScore, catalystType,
//           verification, volume, sessionFrac, missing:[], passedFilter, tradeable, status? }
export function recordObservation(store, obs) {
  const key = String(obs.ticker || '').toUpperCase();
  if (!key) return null;
  const hhmm = hhmmIST();
  const ts = new Date().toISOString();
  const entry = store.candidates[key] || {
    ticker: key, fullName: obs.fullName || key, sector: obs.sector || null,
    firstSeen: hhmm, status: 'watching', scans: [],
  };
  entry.fullName = obs.fullName || entry.fullName;
  entry.sector = obs.sector || entry.sector;
  entry.lastSeen = hhmm;
  entry.scans.push({
    hhmm, ts,
    relVol: obs.relVol ?? null,
    confidence: obs.confidence ?? null,
    discoveryScore: obs.discoveryScore ?? null,
    catalystType: obs.catalystType ?? null,
    verification: obs.verification ?? null,
    volume: obs.volume ?? null,
    sessionFrac: obs.sessionFrac ?? null,
    missing: obs.missing || [],
    passedFilter: !!obs.passedFilter,
    tradeable: !!obs.tradeable,
  });
  if (entry.scans.length > 12) entry.scans = entry.scans.slice(-12); // cap a day's scans
  const confs = entry.scans.map(s => s.confidence);
  entry.bestConfidence = Math.max(...confs.filter(v => v != null && isFinite(v)), 0);
  const t = confidenceTrend(confs);
  entry.confidenceTrend = t.trend;
  entry.confidenceSlope = t.slope;
  entry.trendBonus = confidenceTrendBonus(confs);
  if (obs.status) entry.status = obs.status;
  else if (obs.tradeable) entry.status = 'qualified';
  store.candidates[key] = entry;
  return entry;
}

// Previous-scan volume map for the discovery score's cross-scan acceleration signal:
// Map(symbol -> { volume, frac }) from each candidate's most recent scan.
export function prevVolumeMap(store) {
  const m = new Map();
  for (const [sym, entry] of Object.entries(store?.candidates || {})) {
    const last = entry.scans?.[entry.scans.length - 1];
    if (last && last.volume != null && last.sessionFrac != null) m.set(sym, { volume: last.volume, frac: last.sessionFrac });
  }
  return m;
}

// Mark a candidate as bought (so later scans don't re-evaluate it as a fresh opportunity).
export function markBought(store, ticker) {
  const key = String(ticker || '').toUpperCase();
  if (store?.candidates?.[key]) store.candidates[key].status = 'bought';
}
