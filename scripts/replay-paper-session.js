// Read-only sources -> isolated estimated historical replay JSON on stdout.
// The caller saves the report with apply_patch; never writes the live account.
import { execFileSync } from "node:child_process";
import { replayPaperSession } from "../research/session-replay.js";
const date = process.argv[2] || "2026-11-04",
  ref = process.argv[3] || "origin/main";
if (!/^2026-\d{2}-\d{2}$/.test(date)) throw Error("Expected YYYY-MM-DD");
const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 30000000 });
const hashes = (file) =>
  git([
    "log",
    ref,
    `--since=${date}T00:00:00+05:30`,
    `--until=${date}T23:59:59+05:30`,
    "--format=%H",
    "--",
    file,
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .reverse();
const fileAt = (sha, path) => JSON.parse(git(["show", `${sha}:${path}`]));
const states = hashes("data/paper-simulation.json")
  .map((sha) => ({ sha, state: fileAt(sha, "data/paper-simulation.json") }))
  .filter(
    ({ state: s }) =>
      s.lastCheck?.action === "scan" && s.updatedAt?.startsWith(date),
  );
const snapshots = hashes("data/nse-snapshot.json").map((sha) =>
  fileAt(sha, "data/nse-snapshot.json"),
);
// Include the snapshot already present at the first morning decision (committed yesterday).
if (states.length)
  snapshots.push(fileAt(states[0].sha, "data/nse-snapshot.json"));
const scans = states.map(({ sha, state: s }) => {
  const at = Date.parse(s.updatedAt),
    snap = snapshots
      .filter((d) => Date.parse(d.fetchedAt) <= at)
      .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
  return {
    at: s.updatedAt,
    sourceCommit: sha,
    suggestions: s.suggestions,
    dailyCache: s.dailyCache,
    safetyReady:
      !!snap &&
      at - Date.parse(snap.fetchedAt) <= 4 * 3600000 &&
      snap.diag?.surveillance === true &&
      Array.isArray(snap.data?.surveillance),
    negativeSymbols: (snap?.data?.announcements || [])
      .filter((a) =>
        /fraud|insolvency|bankrupt|order cancellation|default on|sebi.*(penalty|action)|investigation/i.test(
          a.subject || "",
        ),
      )
      .map((a) => a.symbol),
  };
});
const names = [
    ...new Set(scans.flatMap((s) => s.suggestions.map((r) => r.ticker))),
  ],
  series = {},
  errors = {};
async function chart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw Error(`history HTTP ${r.status}`);
  const raw = await r.json(),
    c = raw.chart?.result?.[0];
  if (!c) throw Error("no historical chart");
  const q = c.indicators?.quote?.[0] || {};
  const candles = (c.timestamp || [])
    .map((t, i) => [
      new Date(t * 1000).toISOString(),
      q.open?.[i],
      q.high?.[i],
      q.low?.[i],
      q.close?.[i],
      q.volume?.[i],
    ])
    .filter(
      (row) =>
        row[0].slice(0, 10) === date &&
        row.slice(1, 5).every((n) => Number.isFinite(n) && n > 0) &&
        Number.isFinite(row[5]) &&
        row[5] >= 0,
    );
  return {
    candles,
    previousClose: c.meta.chartPreviousClose ?? c.meta.previousClose,
    source: url,
  };
}
for (let i = 0; i < names.length; i += 3)
  await Promise.all(
    names.slice(i, i + 3).map(async (symbol) => {
      try {
        series[symbol] = await chart(symbol + ".NS");
      } catch (e) {
        errors[symbol] = e.message;
      }
    }),
  );
let benchmark;
try {
  benchmark = await chart("^NSEI");
} catch (e) {
  errors.NIFTY = e.message;
}
const replay = replayPaperSession({ date, scans, series, benchmark });
replay.source = {
  ref,
  lastCommit: states.at(-1)?.sha,
  archivedScans: scans.length,
  consideredTickers: names.length,
  availableIntradaySeries: Object.keys(series).length,
  historyFailures: errors,
  historicalProvider:
    "Yahoo Finance one-minute OHLC; not historical bid/ask depth",
};
console.log(JSON.stringify(replay, null, 2));
