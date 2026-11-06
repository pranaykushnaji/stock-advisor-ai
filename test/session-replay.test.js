import test from "node:test";
import assert from "node:assert/strict";
import { replayPaperSession } from "../research/session-replay.js";
import { LEGACY_SIM_CONFIG } from '../api/_paper-simulation.js';
import {BASELINE_SIM_CONFIG} from '../research/paper-policy.js';
const at = Date.parse("2026-11-04T04:30:05Z"),
  boundary = Math.floor(at / 300000) * 300000;
const candles = Array.from({ length: 40 }, (_, i) => [
  new Date(boundary - 35 * 60000 + i * 60000).toISOString(),
  i < 30 ? 100 : i < 35 ? 100.3 : 95,
  i < 30 ? 100.2 : i < 35 ? 101.2 : 95.2,
  i < 30 ? 99.5 : i < 35 ? 100.3 : 94.9,
  i < 30 ? 100 : i < 35 ? 101 : 95,
  i < 30 ? 100 : 300,
]);
function input() {
  return {
    date: "2026-11-04",
    config:BASELINE_SIM_CONFIG,
    generatedAt: new Date(at + 600000).toISOString(),
    scans: [0, 300000].map((delta) => ({
      at: new Date(at + delta).toISOString(),
      sourceCommit: "point-in-time-" + delta,
      safetyReady: true,
      suggestions: [
        {
          ticker: "ABC",
          sector: "IT",
          price: delta ? 95 : 101,
          observedAt: new Date(at + delta).toISOString(),
        },
      ],
      dailyCache: {
        ABC: { asOf: "2026-11-04", ema20: 99, averageTurnoverCr: 20 },
      },
    })),
    series: { ABC: { candles, previousClose: 100 } },
    benchmark: {
      candles: candles.map((r) => [r[0], 100, 100, 100, 100, r[5]]),
      previousClose: 100,
    },
  };
}
test("replay records only a labelled estimated scenario, enforces cash and includes losses", () => {
  const r = replayPaperSession(input());
  assert.equal(r.summary.newPositions, 1);
  assert.equal(r.trades.length, 1);
  const p = r.trades[0];
  assert.equal(p.historicalReplay, true);
  assert.equal(p.synthetic, true);
  assert.equal(p.executed, false);
  assert.equal(p.excludeFromLiveStatistics, true);
  assert.match(p.executionConfidence, /ESTIMATED/);
  assert.ok(p.realizedNetPnl < 0);
  assert.ok(r.invested <= 10000);
  assert.ok(p.investedAmount <= 5000);
  assert.ok(p.modeledInitialRisk <= 100);
  assert.equal(p.shares,1);
  assert.equal(r.cash, Math.round((r.capital + p.realizedNetPnl) * 100) / 100);
  const legacy=replayPaperSession({...input(),config:LEGACY_SIM_CONFIG});
  assert.equal(legacy.capital,10000);assert.ok(legacy.trades[0].shares>1);
});
test("future breakout bars and unavailable historical benchmark cannot authorize an earlier entry", () => {
  const d = input();
  d.scans = [
    {
      ...d.scans[0],
      at: new Date(at - 300000).toISOString(),
      suggestions: [
        {
          ticker: "ABC",
          sector: "IT",
          price: 100,
          observedAt: new Date(at - 300000).toISOString(),
        },
      ],
    },
  ];
  assert.equal(replayPaperSession(d).summary.newPositions, 0);
  d.scans = input().scans;
  d.benchmark = { candles: [], previousClose: 100 };
  assert.equal(replayPaperSession(d).summary.newPositions, 0);
});
test("historical safety and same-day de-dup remain mandatory", () => {
  const d = input();
  d.scans = d.scans.map((s) => ({ ...s, safetyReady: false }));
  assert.equal(replayPaperSession(d).summary.newPositions, 0);
  const r = replayPaperSession(input());
  assert.equal(r.checks.filter((c) => c.bought).length, 1);
});
