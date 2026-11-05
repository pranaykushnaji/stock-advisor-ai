// Lightweight, data-honest presentation. No synthetic charts, probabilities or orders.
import {performanceSummary} from './performance.js';
const paths = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  signal: "m3 17 6-6 4 4 8-10 M15 5h6v6",
  wallet: "M3 6h16v14H3z M3 6V4h14 M15 11h6v5h-6z",
  chart: "M4 3v17h17 M8 15l4-5 4 2 5-7",
  arrow: "M5 12h14 m-5-5 5 5-5 5",
  pulse: "M2 12h5l3-8 4 16 3-8h5",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-6",
  clock: "M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
};
export const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.signal}"/></svg>`;
const safeClass = (value) =>
  Number.isFinite(value)
    ? value > 0
      ? "positive"
      : value < 0
        ? "negative"
        : ""
    : "";
const shortTime = (value) =>
  Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "—";
function symbolMark(symbol, e) {
  return `<span class="symbol-mark tone-${[...String(symbol)].reduce((s, c) => s + c.charCodeAt(0), 0) % 5}">${e(String(symbol).slice(0, 2))}</span>`;
}
export function sparkline(points, { label = "Observed scan prices", e } = {}) {
  const prices = (points || []).map((p) => p.price).filter(Number.isFinite);
  if (prices.length < 2)
    return `<div class="trace-empty">${e(label)} · collecting observations</div>`;
  const lo = Math.min(...prices),
    hi = Math.max(...prices),
    span = hi - lo || 1;
  const xy = prices
    .map(
      (p, i) =>
        `${((i / (prices.length - 1)) * 160).toFixed(1)},${(42 - ((p - lo) / span) * 32).toFixed(1)}`,
    )
    .join(" ");
  return `<svg class="sparkline ${safeClass(prices.at(-1) - prices[0])}" viewBox="0 0 160 50" role="img" aria-label="${e(label)}: ${e(prices[0])} to ${e(prices.at(-1))}; sampled observations, not captured returns"><path class="spark-grid" d="M0 45H160 M0 25H160"/><polyline points="${xy}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
export function renderSignalCards(
  rows,
  f,
  details = () => "",
  { compact = false } = {},
) {
  const { e, money, decimal, percent } = f;
  if (!rows.length)
    return `<div class="empty signal-empty">${icon("search")}<h2>Room for the right opportunity.</h2><p>No suggestions match this view. The engine will keep scanning; cash does not have to be invested.</p></div>`;
  return `<div class="opportunity-grid ${compact ? "compact" : ""}">${rows
    .map((row) => {
      const picked = row.status === "Simulated pick",
        score = Number.isFinite(row.discoveryScore)
          ? Math.max(0, Math.min(100, row.discoveryScore))
          : null;
      return `<article class="opportunity-card ${picked ? "is-picked" : ""}"><div class="stock-top"><div class="stock-identity">${symbolMark(row.ticker, e)}<div><h${compact ? "3" : "2"}>${e(row.ticker)}</h${compact ? "3" : "2"}><p class="company-name">${e(row.name)}</p></div></div><span class="badge ${picked ? "picked" : row.status === "Watch" ? "watch" : "warning"}">${e(row.status)}</span></div>
      <div class="stock-price"><strong>${e(money(row.price))}</strong><span class="${safeClass(row.sessionChangePct)}">${Number.isFinite(row.sessionChangePct) ? e(percent(row.sessionChangePct)) + " · " + e(row.sessionDate || "saved session") : "Saved observation"}</span></div>
      ${picked ? `<p class="signal-return"><strong class="${safeClass(row.entryReturnPct)}">${e(percent(row.entryReturnPct))}</strong> ${row.closedPick ? 'net since entry · closed' : 'since entry · before costs'}${row.shares ? ` · 1 entry, ${e(row.shares)} shares` : ''}</p>` : Number.isFinite(row.sinceFirstSeenPct) ? `<p class="signal-return"><strong class="${safeClass(row.sinceFirstSeenPct)}">${e(percent(row.sinceFirstSeenPct))}</strong> since first suggestion · not a trade</p>` : ''}
      <div class="signal-score"><span>Discovery score <strong>${score === null ? "—" : e(decimal(score))}<small>/100</small></strong></span><div class="score-track"><span style="width:${score ?? 0}%"></span></div></div>
      <p class="stock-blocker">${picked ? icon("shield") : icon("clock")}<span>${e(row.currentReason)}</span></p>
      <div class="stock-bottom"><span>${e(row.sector || "Sector unavailable")}</span><span>${e(shortTime(row.priceAt || row.chosenAt))} IST</span></div>
      ${!compact ? `<div class="research-proof"><span class="proof-dot ${row.verification === "VERIFIED" ? "verified" : ""}"></span>${e(row.verification === "VERIFIED" ? "Verified event + technical checks" : row.research ? "Advisor research · not verified" : "Price + volume research")}</div>${sparkline(row.observations, { e, label: "Prices since first recorded suggestion" })}<div class="observation-caption">${Number.isFinite(row.sinceFirstSeenPct) ? `Since first recorded suggestion: <span class="${safeClass(row.sinceFirstSeenPct)}">${e(percent(row.sinceFirstSeenPct))}</span> · not trade P&L` : "Price history starts with recorded scans; no returns assumed."}</div>${details(row)}` : ""}
    </article>`;
    })
    .join("")}</div>`;
}

export function renderPerformanceTracker(sim, {e,money,percent,dateTime}) {
  const p=performanceSummary(sim);
  if(!p)return '';
  const metric=(title,value,note)=>`<div class="metric"><dl><dt>${e(title)}</dt><dd class="${safeClass(value)}">${e(percent(value))}</dd></dl><p>${e(note)}</p></div>`;
  const olderMarks=(sim.positions||[]).filter(r=>!Number.isFinite(Date.parse(r.lastPriceUpdate))||Date.parse(sim.updatedAt)-Date.parse(r.lastPriceUpdate)>90000);
  return `<section class="return-tracker" aria-label="Percentage gain tracker"><div class="section-row"><div><p class="eyebrow">RETURNS, NOT JUST PRICE MOVES</p><h2>Percentage gain tracker</h2></div><span class="badge">AFTER ESTIMATED COSTS</span></div>
    ${p.duplicateCount||p.duplicateOpenTickers?'<p class="notice warning">Duplicate ledger entries detected. Account percentage returns are unavailable pending reconciliation.</p>':''}
    <div class="metrics return-metrics">${metric('Avg profit per closed stock',p.averageClosedStockPct,`${p.closedStocks} unique closed stocks · equal weight per stock`)}${metric('Profit / capital invested',p.deployedReturnPct,`${money(p.accountPnl)} marked P&L / ${money(p.deployedCapital)} deployed`)}${metric('Portfolio / contributions',p.accountReturnPct,`${money(p.accountPnl)} marked P&L / ${money(sim.contributions)} funded`)}</div>
    ${olderMarks.length?`<p class="notice warning">Older marks: ${e(olderMarks.map(r=>r.ticker).join(', '))}. Saved prices are more than 90 seconds older than the last scan, or lack a timestamp. Account returns are marked estimates, not a fresh executable valuation.</p>`:''}
    <details class="return-definitions"><summary>How returns are calculated · saved ${e(dateTime(sim.updatedAt))}</summary><div class="details-body"><p>Average per stock: closed net profit ÷ that stock’s entry capital, then an equal-weight average across unique tickers. Re-entries are combined per stock. Open trades are not counted as closed profits.</p><p>Profit / capital invested: cash + saved open-position value − contributions, divided by all entry notionals, including open trades. Reinvested capital is counted again. This is a return on deployed capital, not a time-weighted portfolio return.</p><p>Portfolio / contributions: marked profit ÷ external contributions. Contributions are not profit. ${e(money(p.closedNet))} is closed net profit; weighted return on closed invested capital is ${e(percent(p.closedWeightedPct))}.</p><p>Open positions use their last saved prices, not guaranteed liquidation prices. Paid entry costs and closed exit costs are included; future exit fees, spread and slippage are not. Quotes can have different timestamps. Nifty’s saved session move uses a different period and is not portfolio alpha.</p><p>Historical replays, voided and synthetic rows do not count as trades. If they appear inside the live account, account returns are withheld instead of mixing scenarios. ${p.excludedCount} excluded rows.</p></div></details></section>`;
}
export function renderWorkspaceOverview({ sim, suggestions, ledger }, f) {
  const { e, money, decimal, dateTime, percent } = f,
    date = new Date((Date.parse(sim.updatedAt)||Date.now()) + 19800000).toISOString().slice(0, 10),
    day = sim.days?.[date];
  const positions = sim.positions || [],
    trades = sim.trades || [],
    performance = performanceSummary(sim), equity = performance?.equity;
  const blocked =
    sim.lastCheck?.entryPause ||
    (sim.discovery?.benchmark?.fresh === false ||
    sim.suggestions?.some((r) =>
      r.reasons?.includes("benchmark price unavailable"),
    )
      ? "Benchmark feed needs attention"
      : null);
  const clockIST=new Date(Date.now()+19800000), minute=clockIST.getUTCHours()*60+clockIST.getUTCMinutes();
  const outsideWindow=[0,6].includes(clockIST.getUTCDay())||minute<480||minute>925;
  const age = Date.now() - Date.parse(sim.updatedAt || ""),
    status = blocked
      ? "Entries blocked"
      : !Number.isFinite(age)
        ? "Awaiting first scan"
        : age > 7 * 60000
          ? outsideWindow ? "Outside scan window" : "Last scan is old"
          : "Scanning";
  const top = suggestions
    .filter((r) => r.status !== "Earlier watch")
    .sort(
      (a, b) =>
        (b.status === "Simulated pick") - (a.status === "Simulated pick") ||
        (b.discoveryScore ?? 0) - (a.discoveryScore ?? 0),
    )
    .slice(0, 3);
  const lastPick = [...positions, ...trades].sort(
    (a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt),
  )[0];
  const history =
    sim.scanHistory?.date === date ? sim.scanHistory.scans || [] : [];
  const net = ledger.estimatedNet;
  return `<div class="section-heading workspace-heading"><div><p class="eyebrow">YOUR SIGNAL WORKSPACE</p><h1>The market. <span>Less noise.</span></h1><p class="muted">Find the setup. Know the risk. Track the outcome.</p></div><span class="session-label">${icon("clock")}${e(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(new Date()))}<span class="badge">NSE · PAPER</span></span></div>
    ${blocked ? `<div class="engine-alert">${icon("shield")}<div><strong>New entries are paused by a data check</strong><p>${e(blocked)}. This is an operational blocker, not evidence that every stock is a poor opportunity. Existing price exits remain separate.</p></div><a href="#system-health">Inspect →</a></div>` : ""}
    <div class="desk-hero"><section class="equity-card"><div class="card-eyebrow"><span>PAPER PORTFOLIO</span><span class="badge">SIMULATED</span></div><div class="equity-value">${e(money(equity))}</div><p class="equity-sub">${e(money(sim.contributions))} contributed <span>·</span> ${positions.length} open ${positions.length === 1 ? "position" : "positions"}</p><p class="portfolio-return ${safeClass(performance?.accountReturnPct)}">${e(percent(performance?.accountReturnPct))} <span>on contributions · since experiment start</span></p>
      <div class="equity-baseline"><span class="baseline-line"></span><span>${trades.length ? `${trades.length} closed paper trades` : "A clean start. Your own evidence, from here."}</span></div>
      <div class="hero-bottom"><div><span>Realized after est. costs</span><strong class="${safeClass(net)}">${e(money(net))}</strong></div><div><span>Open P&L · before costs</span><strong class="${safeClass(ledger.unrealized)}">${e(money(ledger.unrealized))}</strong></div><a class="icon-button" href="#results" aria-label="See paper trading results">${icon("arrow")}</a></div></section>
      <section class="engine-card"><div class="inline-heading"><h2>${icon("pulse")} Engine pulse</h2><span class="status-pill ${blocked ? "is-warning" : ""}"><i></i>${e(status)}</span></div><div class="engine-stat"><span>Market coverage</span><strong>${e(decimal(sim.discovery?.quotesReceived ?? null))}<small> / ${e(decimal(sim.discovery?.requested ?? null))} quotes</small></strong></div><div class="engine-stat"><span>Entry & exit cadence</span><strong>Every 5 minutes</strong></div><div class="engine-stat"><span>Nifty · ${e(date)} saved session</span><strong class="${safeClass(sim.discovery?.benchmark?.changePct)}">${sim.discovery?.benchmark?.fresh ? e(percent(sim.discovery.benchmark.changePct)) : "Needs attention"}</strong></div><div class="engine-stat"><span>Last saved scan</span><strong>${e(dateTime(sim.updatedAt))}</strong></div><a href="#system-health" class="engine-link">Data & safety checks ${icon("arrow")}</a></section></div>
    ${renderPerformanceTracker(sim,f)}
    <div class="section-row"><div><p class="eyebrow">THE OPPORTUNITY RADAR</p><h2>Suggestions & picks <span class="count-bubble">${suggestions.length}</span></h2></div><a class="text-link" href="#suggestions">Explore all ${icon("arrow")}</a></div>
    ${renderSignalCards(top, f, undefined, { compact: true })}
    <div class="metrics compact-metrics"><div class="metric"><dt>${icon("wallet")} Daily investment left</dt><dd>${e(money(Math.max(0, (sim.config?.dailyInvestment??10000) - (day?.invested || 0))))}</dd><p>${e(date)} · allowance includes costs</p></div><div class="metric"><dt>${icon("signal")} New positions · ${e(date)}</dt><dd>${day?.buys?.length ?? 0}<small> / ${e(sim.config?.maxBuysPerDay??3)}</small></dd><p>Positions, not number of shares.</p></div><div class="metric"><dt>${icon("shield")} Modeled initial risk</dt><dd>₹100<small> / trade</small></dd><p>Gaps can exceed the modeled loss.</p></div></div>
    <div class="lower-grid"><section class="panel panel-pad scan-panel"><div class="inline-heading"><h2>${icon("pulse")} Scan activity</h2><span class="badge">5 MIN</span></div>${
      history.length
        ? `<div class="scan-timeline">${history
            .slice(-12)
            .map(
              (s) =>
                `<div class="scan-tick ${s.bought ? "has-pick" : s.benchmarkFresh === false ? "is-blocked" : ""}" title="${e(dateTime(s.at))}: ${e(s.bought ? "paper pick " + s.bought : s.benchmarkFresh === false ? "benchmark unavailable" : "scan recorded")}"><span></span><small>${e(shortTime(s.at))}</small></div>`,
            )
            .join(
              "",
            )}</div><p class="small muted">${history.length} saved scans · bars represent completed checks, not investment performance.</p>`
        : `<div class="timeline-empty">${icon("pulse")}<p>Building a visible scan trail.<span>Only recorded checks appear here.</span></p></div>`
    }</section><section class="panel panel-pad latest-pick"><p class="eyebrow">LATEST AI PICK</p><h2>${lastPick ? e(lastPick.ticker) : "Conviction cannot be rushed."}</h2><p class="muted">${lastPick ? `${e(money(lastPick.entryPrice))} simulated entry · ${e(shortTime(lastPick.addedAt))} IST` : "The engine waits for a fresh quote and a confirmed setup. A suggestion is not a purchase."}</p><a class="text-link" href="#positions">Open positions ${icon("arrow")}</a></section></div>
    <details class="panel trading-rules"><summary>Experiment rules & assumptions <span>Expand +</span></summary><div class="details-body"><p>Paper only. Up to ₹10,000/day invested, ₹5,000 per position, three new positions/day and five open positions. Whole shares; unused cash carries forward. No same-day re-entry.</p><p>Research starts at 08:00 IST; entry and exit checks run every five minutes from 09:15–15:25. Completed opening-range or consolidation confirmation is required. No fixed 10:00 entry gate.</p><p>Initial structure stop is frozen. Trailing protection is sampled every five minutes; gaps, circuits and missing quotes can exceed ₹100 modeled risk/trade and ₹500 aggregate initial risk. No guaranteed return.</p><p>Entry = observed ask + 5bp; exit = observed bid − 5bp. Estimated costs: 15bp per side. This is an unproven forward paper experiment, not a validated profit forecast. Archived legacy results are not mixed in. Version ${e(sim.strategyVersion)}.</p></div></details>`;
}

export function renderReplayPanel(replay, { e, money, dateTime }) {
  if (!replay) return "";
  const rows = [...(replay.positions || []), ...(replay.trades || [])].sort(
    (a, b) => Date.parse(a.entryAt) - Date.parse(b.entryAt),
  );
  const equity =
    replay.cash +
    (replay.positions || []).reduce((s, p) => s + p.currentPrice * p.shares, 0);
  return `<section class="panel panel-pad replay-panel"><div class="inline-heading"><div><p class="eyebrow">SEPARATE COUNTERFACTUAL SCENARIO</p><h2>Morning replay · ${e(replay.date)}</h2></div><span class="badge warning">ESTIMATED · NOT EXECUTED</span></div><p class="muted small">What the updated rules selected from the original, timestamped suggestions. This is not the live account and is never added to its P&L.</p><div class="replay-summary"><div><span>Daily study capital</span><strong>${e(money(replay.capital))}</strong></div><div><span>New / open / closed</span><strong>${replay.summary.newPositions} / ${replay.summary.openPositions} / ${replay.summary.closedTrades}</strong></div><div><span>Marked equity · exit costs pending</span><strong>${e(money(equity))}</strong></div></div>
    <div class="replay-trades">${rows.map((p) => `<article><div><strong>${e(p.ticker)}</strong><span>${e(dateTime(p.entryAt))}</span></div><dl class="key-values"><div><dt>Original reference → modeled entry</dt><dd>${e(money(p.observedReferencePrice))} → ${e(money(p.entryPrice))}</dd></div><div><dt>Shares / initial stop</dt><dd>${p.shares} / ${e(money(p.initialStopPrice))}</dd></div><div><dt>Recorded status</dt><dd>${p.exitAt ? "Closed in replay" : "Open in replay"}</dd></div><div><dt>${p.exitAt ? "Realized after estimated costs" : "Latest historical mark · not a sale"}</dt><dd>${e(money(p.exitAt ? p.realizedNetPnl : p.currentPrice))}</dd></div></dl></article>`).join("")}</div>
    <p class="notice warning">Historical depth was not saved. Fills assume a 30bp spread, 5bp slippage per side and 15bp costs per side. Execution-time circuit checks are unverified. These are conditional estimated entries—not proof that each live order would have filled.</p><details><summary>Replay evidence & limitations</summary><div class="details-body"><p>As of ${e(dateTime(replay.asOf))}. ${replay.source?.archivedScans ?? replay.checks?.length ?? 0} archived scans; only original candidate lists were considered. No morning-open fill was borrowed for a later signal.</p><ul>${(replay.limitations || []).map((l) => `<li>${e(l)}</li>`).join("")}</ul></div></details></section>`;
}
