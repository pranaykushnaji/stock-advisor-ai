// Lightweight, data-honest presentation. No synthetic charts, probabilities or orders.
import {performanceSummary,positionReturnPct,tradeNetReturnPct} from './performance.js';
import {SIM_CONFIG} from '../research/paper-policy.js';
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
function overviewStatus(sim) {
  const blocked=sim.lastCheck?.entryPause||((sim.discovery?.benchmark?.fresh===false||sim.suggestions?.some(r=>r.reasons?.includes('benchmark price unavailable')))?'Benchmark feed needs attention':null);
  const clock=new Date(Date.now()+19800000),minute=clock.getUTCHours()*60+clock.getUTCMinutes();
  const outside=[0,6].includes(clock.getUTCDay())||minute<480||minute>925;
  const age=Date.now()-Date.parse(sim.updatedAt||'');
  return {blocked,label:blocked?'Entries paused':!Number.isFinite(age)?'Awaiting scan':age>7*60000?(outside?'Outside scan window':'Scan overdue'):'Scanning'};
}

export function renderWorkspaceOverview({sim,suggestions}, f) {
  const {e,money,percent,dateTime}=f, p=performanceSummary(sim),status=overviewStatus(sim);
  const records=[...(sim.positions||[]),...(sim.trades||[])].sort((a,b)=>
    (Date.parse(b.addedAt||b.entryAt)||0)-(Date.parse(a.addedAt||a.entryAt)||0));
  const byTicker=new Map();for(const row of records)if(!byTicker.has(row.ticker))byTicker.set(row.ticker,row);
  const latest=[...byTicker.values()].slice(0,3);
  const watching=!latest.length;
  const rows=watching?suggestions.filter(r=>r.status!=='Earlier watch')
    .sort((a,b)=>(b.discoveryScore??0)-(a.discoveryScore??0)).slice(0,5):latest;
  const olderMarks=(sim.positions||[]).filter(r=>!Number.isFinite(Date.parse(r.lastPriceUpdate))||Date.parse(sim.updatedAt)-Date.parse(r.lastPriceUpdate)>90000);
  const invalid=!p||p.accountPnl===null||p.duplicateCount||p.duplicateOpenTickers;
  return '<div class="section-heading home-heading"><div><p class="eyebrow">YOUR WORKSPACE</p><h1>At a glance.</h1></div><a href="#system" class="home-status '+(status.blocked||status.label==='Scan overdue'?'home-needs-attention':'')+'">'+icon('pulse')+e(status.label)+'</a></div>'+
    (status.blocked?'<p class="notice warning" role="status">New entries paused: '+e(status.blocked)+'. <a href="#system">Check system →</a></p>':'')+
    (invalid?'<p class="notice warning">Return unavailable: the saved account needs a data check. <a href="#system">Review data →</a></p>':'')+
    '<section class="home-performance" aria-label="Paper portfolio summary"><div class="home-return"><p class="eyebrow">TOTAL RETURN · PAPER</p><div class="home-amount '+safeClass(p?.accountPnl)+'">'+e(money(p?.accountPnl))+'</div><p class="home-percentage"><strong class="'+safeClass(p?.deployedReturnPct)+'">'+e(percent(p?.deployedReturnPct))+'</strong><span>on invested capital</span></p><p class="home-valuation-note">Includes saved open gains. Future exit costs are not deducted.</p></div>'+
    '<dl class="home-stats"><div><dt>Avg. profit per closed stock</dt><dd class="'+safeClass(p?.averageClosedStockPct)+'">'+e(percent(p?.averageClosedStockPct))+'</dd></div><div><dt>Open positions</dt><dd><a href="#positions">'+e((sim.positions||[]).length)+icon('arrow')+'</a></dd></div></dl>'+
    '<div class="home-performance-footer"><span>Saved '+e(dateTime(sim.updatedAt))+'</span><a href="#results">View performance '+icon('arrow')+'</a></div></section>'+
    (olderMarks.length?'<p class="home-price-note">'+e(olderMarks.length)+' position'+(olderMarks.length===1?' uses':'s use')+' an older saved price. <a href="#results">Price details →</a></p>':'')+
    '<div class="section-row home-picks-heading"><div><h2>'+(watching?'Watching, not bought':'Latest picks')+'</h2></div><a class="text-link" href="'+(watching?'#suggestions':'#positions')+'">'+(watching?'All suggestions':'All positions')+' '+icon('arrow')+'</a></div>'+
    (rows.length?'<div class="home-picks">'+rows.map(row=>{
      const closed=!watching&&!!row.exitAt, value=watching?row.price:closed?row.exitPrice:row.currentPrice;
      const gain=watching?row.sinceFirstSeenPct:closed?tradeNetReturnPct(row):positionReturnPct(row);
      const destination=watching?'#suggestions':closed?'#results':'#positions';
      return '<article class="home-pick"><div class="home-pick-header">'+symbolMark(row.ticker,e)+'<div><h3>'+e(row.ticker)+'</h3><p>'+e(row.fullName||row.name||row.ticker)+'</p></div><span class="home-pick-label">'+(watching?'Watch':closed?'Closed':'Open')+'</span></div><div class="home-pick-value"><strong>'+e(money(value))+'</strong><span class="'+safeClass(gain)+'">'+e(percent(gain))+'</span></div><p class="home-pick-basis">'+(watching?'Since first suggestion · not trade P&L':closed?'Since entry · after estimated costs':'Since entry · before costs')+'</p><div class="home-pick-footer"><span>'+(watching?'Not a purchase':'Entry '+e(shortTime(row.addedAt||row.entryAt))+' IST')+'</span><a href="'+destination+'" aria-label="'+e('View '+row.ticker+(watching?' research':closed?' result':' position'))+'">View '+icon('arrow')+'</a></div></article>';
    }).join('')+'</div>':'<div class="empty"><h3>No picks yet</h3><p>New suggestions will appear after a saved scan.</p><a class="text-link" href="#suggestions">View suggestions →</a></div>');
}

export function renderWorkspaceSystem(sim,f) {
  if(!sim)return '<p>Simulation state unavailable. Trading rules are not inferred from a missing account.</p>';
  const {e,money,decimal,dateTime,percent}=f,status=overviewStatus(sim);
  const date=new Date((Date.parse(sim.updatedAt)||Date.now())+19800000).toISOString().slice(0,10);
  const history=sim.scanHistory?.date===date?sim.scanHistory.scans||[]:[];
  return '<section class="panel panel-pad"><div class="inline-heading"><h2>Engine & scan activity</h2><span class="badge">'+e(status.label)+'</span></div><dl class="key-values">'+
    '<div><dt>Market coverage</dt><dd>'+e(decimal(sim.discovery?.quotesReceived??null))+' / '+e(decimal(sim.discovery?.requested??null))+'</dd></div>'+
    '<div><dt>Entry and exit checks</dt><dd>Every 5 minutes</dd></div>'+
    '<div><dt>Nifty · '+e(date)+'</dt><dd>'+e(percent(sim.discovery?.benchmark?.fresh?sim.discovery.benchmark.changePct:null))+'</dd></div>'+
    '<div><dt>Last saved scan</dt><dd>'+e(dateTime(sim.updatedAt))+'</dd></div></dl>'+
    (history.length?'<div class="scan-timeline">'+history.slice(-12).map(s=>'<div class="scan-tick '+(s.bought?'has-pick':s.benchmarkFresh===false?'is-blocked':'')+'" title="'+e(dateTime(s.at)+': '+(s.bought?'paper pick '+s.bought:'scan recorded'))+'"><span></span><small>'+e(shortTime(s.at))+'</small></div>').join('')+'</div><p class="small muted">'+history.length+' saved scans · not investment performance.</p>':'<p class="muted small">No saved scan history for this session.</p>')+'</section>'+
    '<section class="panel panel-pad strategy-settings"><h2>Strategy & safeguards</h2><dl class="key-values"><div><dt>New-entry quantity</dt><dd>1 share per stock</dd></div><div><dt>Daily investment / position-count caps</dt><dd>None</dd></div><div><dt>Blanket sector blocker</dt><dd>Removed</dd></div><div><dt>Modeled initial risk per position / total</dt><dd>'+e(money(SIM_CONFIG.modeledRiskPerTrade))+' / '+e(money(SIM_CONFIG.maxModeledOpenRisk))+'</dd></div><div><dt>New-entry policy</dt><dd>'+e(SIM_CONFIG.version)+'</dd></div><div><dt>Last saved scan policy</dt><dd>'+e(sim.strategyVersion)+'</dd></div></dl>'+
    '<details><summary>Execution, funding & exit rules</summary><div class="details-body"><p>Exactly one share per new entry. No daily ₹10,000 allocation, ₹5,000 notional ceiling, three-buy cap, five-open-position cap or blanket same-sector blocker. No count cap overrides the modeled risk limits.</p><p>Existing multi-share positions keep their original quantities until normal exits; history is not rewritten. Existing cash is used first. Additional simulated capital is recorded only when a qualifying entry needs funding. Funding is never profit.</p><p>Research starts at 08:00 IST; entry and exit checks run every five minutes from 09:15–15:25. One new entry at most per scan. Completed opening-range or consolidation evidence is required, with no fixed 10:00 entry gate. No duplicate held ticker or same-day re-entry.</p><p>Initial stops are frozen. Trailing protection, negative-event and time/no-progress exits remain active. One share can still be rejected when its initial modeled risk exceeds ₹100, or open modeled risk would exceed ₹500. Gaps and missing quotes can exceed modeled losses.</p><p>Entry uses the observed ask + 5bp; exit uses the observed bid − 5bp. Estimated costs are 15bp per side. Fresh instrument prices, liquidity, circuit and safety checks remain required. This is paper trading, not a validated profit forecast.</p></div></details></section>';
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
