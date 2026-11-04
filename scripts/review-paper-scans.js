// Read-only audit of actual committed paper suggestions. No hindsight purchases.
import { execFileSync } from "node:child_process";
const date = process.argv[2] || "2026-11-04",
  ref = process.argv[3] || "origin/main";
if (!/^2026-\d{2}-\d{2}$/.test(date))
  throw Error("Expected an exchange-session date");
const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 30000000 });
const commits = git([
  "log",
  ref,
  `--since=${date}T00:00:00+05:30`,
  `--until=${date}T23:59:59+05:30`,
  "--format=%H",
  "--",
  "data/paper-simulation.json",
])
  .trim()
  .split("\n")
  .filter(Boolean)
  .reverse();
const bySymbol = new Map(),
  scans = [];
for (const sha of commits) {
  const s = JSON.parse(git(["show", `${sha}:data/paper-simulation.json`]));
  if (s.lastCheck?.action !== "scan" || !s.updatedAt?.startsWith(date))
    continue;
  scans.push({
    at: s.updatedAt,
    bought: s.lastCheck.bought,
    allBenchmarkBlocked:
      s.suggestions?.length > 0 &&
      s.suggestions.every((r) =>
        r.reasons?.includes("benchmark price unavailable"),
      ),
  });
  for (const r of s.suggestions || []) {
    if (!(r.price > 0)) continue;
    if (!bySymbol.has(r.ticker))
      bySymbol.set(r.ticker, {
        ticker: r.ticker,
        firstAt: r.observedAt,
        firstPrice: r.price,
        observations: [],
      });
    const item = bySymbol.get(r.ticker);
    item.observations.push({
      at: r.observedAt,
      price: r.price,
      reasons: r.reasons,
    });
  }
}
const candidates = [...bySymbol.values()]
  .map((r) => {
    const last = r.observations.at(-1),
      prices = r.observations.map((o) => o.price);
    return {
      ...r,
      lastAt: last.at,
      lastPrice: last.price,
      maxObservedChangePct: (Math.max(...prices) / r.firstPrice - 1) * 100,
      lastChangePct: (last.price / r.firstPrice - 1) * 100,
      rejectionReasons: [
        ...new Set(r.observations.flatMap((o) => o.reasons || [])),
      ],
    };
  })
  .sort((a, b) => b.maxObservedChangePct - a.maxObservedChangePct);
console.log(
  JSON.stringify(
    {
      date,
      ref,
      generatedAt: new Date().toISOString(),
      scans: scans.length,
      benchmarkBlockedScans: scans.filter((s) => s.allBenchmarkBlocked).length,
      candidates,
      limitations: [
        "Observed scan-price changes, not captured profits or tick high/low returns.",
        "Old scans stopped at benchmark validation; they did not record all downstream setup results.",
        "No retrospective trade or morning fill is created.",
      ],
    },
    null,
    2,
  ),
);
