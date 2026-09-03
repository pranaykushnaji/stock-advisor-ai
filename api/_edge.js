// Historical estimates of executed paper trades, NOT out-of-sample evidence of an edge.
export const MIN_EDGE_SAMPLES = 20;
// Friction scenario (slippage + charges), NOT a broker/exchange fee quotation.
export const EDGE_COST_BPS = 30;

function summarize(rows, tier) {
  const returns = rows.map(x => x.realizedPnlPct);
  const wins = returns.filter(x => x > 0), losses = returns.filter(x => x <= 0);
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const n = returns.length, p = n ? wins.length / n : null;
  const z = 1.96, den = 1 + z * z / (n || 1);
  const center = p == null ? null : (p + z * z / (2 * n)) / den;
  const radius = p == null ? null : z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return { samples: n, winRate: p, meanWinPct: mean(wins), meanLossPct: -mean(losses),
    meanReturnPct: mean(returns), tier,
    probabilityInterval95: p == null ? null : [Math.max(0, center - radius), Math.min(1, center + radius)] };
}

function validTrades(rows, asOf = new Date().toISOString().slice(0, 10)) {
  const seen = new Set();
  return (rows || []).filter(x => {
    // Date-only exits on the signal date have unknown ordering; exclude conservatively.
    if (!Number.isFinite(x.realizedPnlPct) || !x.entryLane || !x.exitDate || x.exitDate >= asOf) return false;
    if (x.voided || x.synthetic || x.backdated) return false;
    const key = `${x.ticker}|${x.entryDate}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function laneStats(realizedTrades, lane, asOf) {
  return summarize(validTrades(realizedTrades, asOf).filter(x => x.entryLane === lane), 'lane');
}

export function similarSetupStats(realizedTrades, { lane, regime, confidence, asOf } = {}) {
  const t = validTrades(realizedTrades, asOf).filter(x => x.entryLane === lane);
  const bucket = Number.isFinite(confidence) ? Math.floor(confidence / 10) : null;
  const tiers = [
    { tier: 'lane+regime+conf', rows: t.filter(x => x.regime === regime && bucket != null && Number.isFinite(x.effectiveConfidence) && Math.floor(x.effectiveConfidence / 10) === bucket) },
    { tier: 'lane+regime', rows: t.filter(x => x.regime === regime) },
    { tier: 'lane', rows: t },
  ];
  for (const { tier, rows } of tiers) if (rows.length >= MIN_EDGE_SAMPLES) return summarize(rows, tier);
  return summarize(t, 'insufficient');
}

// Compatibility export: confidence alone must never create a probability.
export function winProbability({ laneWinRate = null, laneSamples = 0 } = {}) {
  return laneSamples >= MIN_EDGE_SAMPLES && Number.isFinite(laneWinRate) ? laneWinRate : null;
}

export function expectedEdge({ history, costBps = EDGE_COST_BPS } = {}) {
  const enough = history?.samples >= MIN_EDGE_SAMPLES
    && [history.winRate, history.meanWinPct, history.meanLossPct].every(Number.isFinite);
  const base = { modelVersion: 'historical-payoff-v1', samples: history?.samples || 0,
    minimumSamples: MIN_EDGE_SAMPLES, calibration: history?.tier || 'insufficient',
    costBps, outOfSampleValidated: false,
    probabilityInterval95: history?.probabilityInterval95 || null };
  if (!enough) return { ...base, status: 'insufficient-evidence', expectedGainPct: null,
    expectedLossPct: null, probability: null, edgePct: null,
    reason: `need ${MIN_EDGE_SAMPLES} comparable completed trades; have ${base.samples}` };
  const p = history.winRate, gain = history.meanWinPct, loss = history.meanLossPct;
  const edge = p * gain - (1 - p) * loss - costBps / 100;
  return { ...base, status: 'historical-estimate', expectedGainPct: +gain.toFixed(2),
    expectedLossPct: +loss.toFixed(2), probability: +p.toFixed(3), edgePct: +edge.toFixed(2),
    reason: 'observed paper-trade payoffs after stated friction; not a validated forecast' };
}
