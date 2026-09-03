import { exitBands, rulesGate } from './_sell-engine.js';
import { seedRisk } from './_position-risk.js';

// Daily OHLC cannot reveal intraday ordering or reproduce hourly polling. The default path
// is open -> low -> high -> close; callers can test high-first sensitivity explicitly.
// A new high NEVER changes an earlier opening fill. Entry is at fwd[0].open, day zero.
export function simSellEngine(entry, fwd, entryCloses = [], opts = {}) {
  if (!(entry > 0) || !fwd?.length) return null;
  const slip = (opts.slippageBps ?? 15) / 10000;
  const costsPct = (opts.transactionCostBps ?? 0) / 100;
  const item = seedRisk({ entryPrice: entry, currentPrice: entry, peakPrice: entry,
    entryLane: opts.lane, date: fwd[0].date, thesisScore: opts.thesisScore ?? 50 },
  exitBands(entryCloses, opts.lane));
  const trail = [...(entryCloses || [])];
  const result = (row, fill, reason, day) => ({ date: row.date, fillPrice: fill * (1 - slip),
    retPct: +((fill * (1 - slip) / entry - 1) * 100 - costsPct).toFixed(2), reason, day,
    executionModel: 'daily-OHLC-assumed-path', intradayPath: opts.intradayPath || 'low-first' });
  const activeStop = () => Math.max(item.initialStopPrice, item.trailingStopPrice || 0);
  for (let i = 0; i < fwd.length; i++) {
    const row = fwd[i];
    const o = row.open ?? row.close, hi = row.high ?? row.close, lo = row.low ?? row.close, c = row.close;
    // On entry day slippage may make the assumed entry slightly higher than the open.
    if (o <= activeStop()) return result(row, o, 'stop gap at observed open', i);
    // Observe opening gap-up before testing the rest of the day. No future high is involved.
    item.currentPrice = o; item.peakPrice = Math.max(item.peakPrice, o);
    rulesGate(item, null, { heldSessions: i }); // update trailing state only
    const points = opts.intradayPath === 'high-first' ? [hi, lo, c] : [lo, hi, c];
    for (const p of points) {
      if (p <= activeStop()) return result(row, activeStop(), 'intraday stop (assumed OHLC path)', i);
      item.currentPrice = p; item.peakPrice = Math.max(item.peakPrice, p);
      rulesGate(item, null, { heldSessions: i });
    }
    trail.push(c);
    const decision = rulesGate(item, trail, { heldSessions: i });
    if (decision) return result(row, c, decision.reason, i);
  }
  const last = fwd.at(-1);
  return result(last, last.close, `window end (${fwd.length} sessions; not a strategy exit)`, fwd.length - 1);
}
