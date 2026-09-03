// Read-only audit. Never fetches a quote, runs a cron, rewrites a trade or invents a fill.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectedEdge, similarSetupStats } from '../api/_edge.js';

const root = new URL('../', import.meta.url);
const trades = JSON.parse(fs.readFileSync(new URL('data/realized.json', root), 'utf8')).trades || [];
const asOf = process.argv.find(x => x.startsWith('--as-of='))?.split('=')[1]
  || new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const avg = a => a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
const sum = a => a.reduce((s, n) => s + n, 0);
const closed = trades.filter(t => t.exitDate <= asOf && Number.isFinite(t.realizedPnlPct));
const laneAudit = ['momentum', 'catalyst'].map(lane => ({ lane,
  currentGateEstimate: expectedEdge({ history: similarSetupStats(closed, { lane, asOf }) }) }));
const withForecast = closed.filter(t => Number.isFinite(t.expectedEdge?.edgePct));
console.log(JSON.stringify({
  asOf, source: fileURLToPath(new URL('data/realized.json', root)),
  closedTrades: closed.length, wins: closed.filter(t => t.realizedPnlPct > 0).length,
  grossPnl: +sum(closed.map(t => t.realizedPnl || 0)).toFixed(2),
  meanTradeReturnPct: avg(closed.map(t => t.realizedPnlPct)),
  recordedForecasts: { count: withForecast.length,
    meanPredictedEdgePct: avg(withForecast.map(t => t.expectedEdge.edgePct)),
    meanActualReturnPct: avg(withForecast.map(t => t.realizedPnlPct)) },
  frictionScenarios: [0, 15, 30, 60].map(bps => ({ roundTripBps: bps,
    meanNetTradeReturnPct: avg(closed.map(t => t.realizedPnlPct - bps / 100)),
    netPnl: +sum(closed.map(t => (t.realizedPnl || 0) - (t.entryPrice * t.shares || t.investedAmount || 0) * bps / 10000)).toFixed(2) })),
  laneAudit,
  trades: closed.map(t => ({ ticker: t.ticker, lane: t.entryLane || 'unknown',
    entryDate: t.entryDate, exitDate: t.exitDate, entryPrice: t.entryPrice, exitPrice: t.exitPrice,
    grossReturnPct: t.realizedPnlPct, exitReason: t.exitReason,
    recordedForecast: t.expectedEdge || null,
    // Walk-forward accounting only: no current/future exits enter the historical estimate.
    evidenceAvailableBeforeEntry: expectedEdge({ history: similarSetupStats(closed, {
      lane: t.entryLane, regime: t.regime, confidence: t.effectiveConfidence, asOf: t.entryDate }) }),
    replayStatus: 'not-replayed: timestamped intraday quotes, original stops and thesis snapshots not archived',
  })),
  limitations: ['Mixed strategy versions; recorded paper trades are not a clean experiment.',
    'Cost values are sensitivity scenarios, not actual fees. No historical ledger is changed.',
    'This is an accounting/calibration audit, NOT a counterfactual execution backtest.',
    'No portfolio or benchmark return is inferred without capital and exposure history.',
    'New gates can pause all entries. Rejected-candidate research must establish evidence before enabling a new setup; do not bypass the gate to bootstrap trades.'],
}, null, 2));
