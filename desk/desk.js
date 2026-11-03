/* Static, read-only desk. Exported helpers have no browser or network dependencies. */
import { laneStats, expectedEdge, EDGE_COST_BPS } from '../research/evidence.js';
const MAIN_DATA = 'https://raw.githubusercontent.com/pranaykushnaji/stock-advisor-ai/main/data/';
export const SOURCES = Object.freeze([
  ...['daily-pick', 'intraday-candidates', 'project-bouquet', 'realized', 'nse-snapshot', 'paper-simulation'].map(name => ({
    name, url: `${MAIN_DATA}${name}.json`, label: 'Public main branch',
  })),
  { name: 'universe', url: '../research/universe.json', label: 'Local official-universe registry' },
]);
const NA = 'Not available';
const asArray = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const firstNumber = (...values) => values.map(number).find(value => value !== null) ?? null;
const positive = (...values) => values.map(number).find(value => value !== null && value > 0) ?? null;
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const e = escapeHTML;
export const money = value => number(value) === null ? NA : new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 2,
}).format(value);
const decimal = value => number(value) === null ? NA : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(value);
const percent = value => number(value) === null ? NA : `${value > 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
const tone = value => number(value) === null || value === 0 ? '' : value > 0 ? 'positive' : 'negative';

export function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Date-only records refer to an IST date; never silently interpret them as UTC midnight.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00+05:30` : value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}
export function dateTime(value) {
  const ms = timestamp(value);
  if (ms === null) return NA;
  return `${new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ms)} IST`;
}
export function freshness(value, now = Date.now()) {
  const ms = timestamp(value);
  if (ms === null) return { label: 'Age unknown', stale: true };
  if (ms > now + 300000) return { label: 'Future timestamp — check source', stale: true };
  const minutes = Math.max(0, Math.floor((now - ms) / 60000));
  const age = minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
  return { label: `${age} old${minutes > 1440 ? ' · Stale (>24h)' : ' · Saved observation'}`, stale: minutes > 1440 };
}
const latestTime = values => values.filter(value => timestamp(value) !== null)
  .sort((a, b) => timestamp(b) - timestamp(a))[0] ?? null;
export function sourceTime(name, data) {
  const explicit = data?.generatedAt ?? data?.updatedAt ?? data?.fetchedAt ?? data?.asOf;
  if (explicit) return { value: explicit, kind: 'Source timestamp' };
  if (name === 'daily-pick') return { value: data?.pick?.pickedAt ?? data?.pick?.date, kind: 'Daily decision time' };
  if (name === 'intraday-candidates') return {
    value: latestTime(Object.values(object(data?.candidates)).flatMap(c => asArray(c.scans).map(s => s.ts))) ?? data?.date,
    kind: 'Latest scan (not file generation)',
  };
  if (name === 'realized') return {
    value: latestTime(asArray(data?.trades).map(t => t.exitAt ?? t.exitDate)),
    kind: 'Latest exit activity; file age unknown',
  };
  return { value: null, kind: 'Source timestamp not supplied' };
}
export function validateData(name, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a JSON object');
  const valid = {
    'daily-pick': () => data.pick && typeof data.pick === 'object',
    'intraday-candidates': () => data.candidates && typeof data.candidates === 'object',
    'project-bouquet': () => Array.isArray(data.bouquet),
    realized: () => Array.isArray(data.trades),
    'nse-snapshot': () => data.data && typeof data.data === 'object' && data.diag,
    universe: () => registryMembers(data).length > 0,
    'paper-simulation': () => data.version===1 && data.mode==='experimental-paper-only' && Array.isArray(data.positions) && Array.isArray(data.trades),
  };
  if (!valid[name]?.()) throw new Error('Unrecognized or incomplete data structure');
  return data;
}

export function quoteIndex(snapshot) {
  const map = new Map();
  // Snapshot universe has priority over duplicated movers lists.
  for (const row of [...asArray(snapshot?.data?.topGainers), ...asArray(snapshot?.data?.topLosers), ...asArray(snapshot?.data?.universe)]) {
    if (row.symbol) map.set(row.symbol, row);
  }
  return map;
}
function latestScan(candidate) {
  return asArray(candidate?.scans).map((scan, index) => ({ scan, index }))
    .sort((a, b) => (timestamp(b.scan.ts) ?? b.index) - (timestamp(a.scan.ts) ?? a.index))[0]?.scan ?? null;
}
function sessionEnd(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? `${date}T15:30:00+05:30` : null;
}
function strings(value) { return asArray(value).filter(v => typeof v === 'string'); }
export function mergeSuggestions(daily, intraday, snapshot, now = Date.now(), registry = null) {
  const pick = object(daily?.pick);
  const merged = new Map();
  const quotes = quoteIndex(snapshot);
  const members = new Map(registryMembers(registry).map(member => [member.symbol, member]));
  for (const row of asArray(pick.considered)) if (row?.ticker) merged.set(row.ticker, { daily: row });
  const candidates = Array.isArray(intraday?.candidates) ? intraday.candidates : Object.values(object(intraday?.candidates));
  for (const candidate of candidates) if (candidate?.ticker) merged.set(candidate.ticker, { ...merged.get(candidate.ticker), candidate });
  return [...merged].map(([ticker, item]) => {
    const candidate = object(item.candidate), d = object(item.daily), scan = latestScan(candidate);
    const s = object(scan);
    const scanAt = s.ts ?? (s.hhmm && intraday?.date ? `${intraday.date}T${s.hhmm}:00+05:30` : null);
    const dailyAt = pick.pickedAt ?? pick.date ?? null;
    const usesDaily = Boolean(item.daily) && (!scan || (timestamp(dailyAt) ?? -Infinity) > (timestamp(scanAt) ?? -Infinity));
    const chosen = usesDaily ? d : s;
    const chosenAt = usesDaily ? dailyAt : scanAt;
    const expiresAt = chosen.expiresAt ?? (usesDaily ? null : candidate.expiresAt) ?? sessionEnd(usesDaily ? pick.date : intraday?.date);
    const expired = timestamp(expiresAt) !== null && timestamp(expiresAt) <= now;
    const reasons = strings(chosen.missing);
    const lanes = object(chosen.lanes ?? chosen.laneDiagnostics ?? (usesDaily ? null : candidate.lanes ?? candidate.laneDiagnostics));
    const laneReasons = Object.entries(lanes).flatMap(([lane, details]) => strings(details?.reasons).map(reason => `${lane}: ${reason}`));
    // Source blockers stay literal. A preliminary scan flag cannot authorize a trade.
    const notQualified = reasons.length > 0 || laneReasons.length > 0 || chosen.tradeable === false || (usesDaily && pick.noTrade === true);
    const quote = quotes.get(ticker), member = members.get(ticker);
    const sector = [member?.sector, candidate.sector, d.sector, quote?.sector]
      .find(value => typeof value === 'string' && value.trim() && !/^(unknown|n\/a|not available)$/i.test(value));
    return {
      ticker, name: candidate.fullName ?? d.fullName ?? ticker,
      sector: sector ?? null, marketCapBucket: member?.marketCapBucket ?? null,
      mappingStatus: member?.mappingStatus ?? null,
      daily: item.daily ?? null, candidate: item.candidate ?? null, scan,
      sources: [item.daily ? 'Daily considered' : null, item.candidate ? 'Intraday' : null].filter(Boolean),
      scanAt, dailyAt, chosenAt, chosenSource: usesDaily ? 'Daily considered' : 'Intraday scan', usesDaily,
      expiresAt, expiryInferred: !chosen.expiresAt && (usesDaily || !candidate.expiresAt),
      expired, status: notQualified ? 'Not qualified' : 'Watch',
      reasons, laneReasons, scanReasons: strings(s.missing),
      dailyReason: item.daily && pick.noTrade ? pick.reason : null,
      currentReason: reasons[0] ?? laneReasons[0] ?? (usesDaily && pick.noTrade ? pick.reason : null) ?? 'Qualification not established; watch only.',
      lane: chosen.entryLane ?? candidate.entryLane ?? null,
      discoveryScore: number(s.discoveryScore), modelScore: number(chosen.confidence),
      effectiveScore: number(d.effectiveConfidence),
      accumulation: firstNumber(chosen.accumulationProxy, chosen.institutional),
      accumulationSource: `${usesDaily ? 'Daily' : 'Scan'} accumulation proxy`,
      flowScore: number(s.components?.flow),
      relVol: number(chosen.relVol), verification: chosen.verification ?? NA,
      catalyst: chosen.catalystType ?? chosen.catalyst ?? NA,
      price: positive(s.lastPrice, s.price, candidate.lastPrice, quote?.lastPrice),
      priceSource: positive(s.lastPrice, s.price, candidate.lastPrice) !== null ? 'Intraday source' : quote ? 'NSE saved snapshot' : NA,
      priceAt: positive(s.lastPrice, s.price, candidate.lastPrice) !== null ? scanAt : snapshot?.fetchedAt,
      vwap: positive(s.vwap, candidate.vwap, quote?.vwap),
      trigger: positive(s.triggerPrice, candidate.triggerPrice, d.triggerPrice),
      stop: positive(s.stopPrice, s.initialStopPrice, candidate.stopPrice, d.stopPrice),
      preliminary: s.tradeable === true,
    };
  }).sort((a, b) => (b.discoveryScore ?? -Infinity) - (a.discoveryScore ?? -Infinity) || a.ticker.localeCompare(b.ticker));
}

export function investedBasis(row) {
  return positive(row.investedAmount) ?? (positive(row.shares) !== null && positive(row.entryPrice) !== null ? row.shares * row.entryPrice : null);
}
export function realizedAmount(row) {
  // Stored rupee P&L is authoritative (shares may be rounded in historical rows).
  if (number(row.realizedPnl) !== null) return number(row.realizedPnl);
  const shares = positive(row.shares), entry = positive(row.entryPrice), exit = positive(row.exitPrice);
  return shares !== null && entry !== null && exit !== null ? (exit - entry) * shares : null;
}
export function positionAmount(row) {
  const shares = positive(row.shares), entry = positive(row.entryPrice), current = positive(row.currentPrice);
  return shares !== null && entry !== null && current !== null ? (current - entry) * shares : null;
}
export function summarizeLedger(trades, positions) {
  const closed = Array.isArray(trades) ? trades : null, open = Array.isArray(positions) ? positions : null;
  const sum = (rows, fn) => rows === null ? null : rows.reduce((total, row) => total + (fn(row) ?? 0), 0);
  const missingRealized = closed?.filter(t => realizedAmount(t) === null).length ?? null;
  const missingOpen = open?.filter(t => positionAmount(t) === null).length ?? null;
  const gross = sum(closed, realizedAmount), unrealized = sum(open, positionAmount);
  const costRows = closed?.filter(t => investedBasis(t) !== null) ?? [];
  const estimatedCosts = closed === null ? null : costRows.reduce((total, t) => total + (number(t.estimatedCostAmount) ?? investedBasis(t) * 0.003), 0);
  return {
    count: closed?.length ?? null, openCount: open?.length ?? null,
    wins: closed?.filter(t => realizedAmount(t) > 0).length ?? null,
    losses: closed?.filter(t => realizedAmount(t) < 0).length ?? null,
    missingRealized, missingOpen, gross, unrealized,
    combined: gross === null || unrealized === null || missingRealized || missingOpen ? null : gross + unrealized,
    estimatedCosts, costCount: costRows.length,
    estimatedNet: gross === null || missingRealized || costRows.length !== closed?.length ? null : gross - estimatedCosts,
  };
}
export function laneEvidence(trades, lane, asOf = new Date().toISOString().slice(0, 10)) {
  const rows = asArray(trades);
  // Keep exclusions, duplicate handling and as-of ordering in the shared pure gate helper.
  const history = laneStats(rows, lane, asOf);
  // Conservatively suppress a cost-adjusted mean if any potentially eligible row lacks capital.
  const completeCosts = rows.filter(row => row.entryLane === lane && Number.isFinite(row.realizedPnlPct)
    && row.exitDate && row.exitDate < asOf && !row.voided && !row.synthetic && !row.backdated)
    .every(row => investedBasis(row) !== null);
  const edge = expectedEdge({ history, costBps: EDGE_COST_BPS });
  return { count: history.samples, eligible: completeCosts ? history.samples : 0,
    meanNetPct: history.samples && completeCosts ? history.meanReturnPct - EDGE_COST_BPS / 100 : null,
    edgePct: completeCosts ? edge.edgePct : null, status: edge.status, asOf };
}

export function registryMembers(registry) {
  for (const key of ['members', 'constituents', 'stocks', 'universe', 'securities', 'instruments']) {
    if (Array.isArray(registry?.[key])) return registry[key];
  }
  return [];
}
export function coverageSummary(snapshot, registry, suggestions = []) {
  const diag = object(snapshot?.diag), members = registryMembers(registry);
  const indexRows = Object.entries(object(diag.indexRows));
  const actualRows = asArray(snapshot?.data?.universe);
  const actualCount = snapshot ? firstNumber(diag.universeCount, actualRows.length ? actualRows.length : null) : null;
  const missingSector = members.length ? members.filter(row => !row.sector || /^(unknown|n\/a|not available)$/i.test(row.sector)).length : null;
  const candidateMissingSector = suggestions.filter(row => !row.sector || /^unknown$/i.test(row.sector)).length;
  const mappedRows = members.filter(row => row.upstoxInstrumentKey || row.instrumentKey || row.upstoxKey || row.upstox?.instrumentKey || row.upstox?.instrument_key);
  const summary = object(registry?.mappingSummary ?? registry?.mapping?.summary ?? registry?.summary);
  return {
    registryCount: registry ? members.length : null, actualCount,
    indicesOk: firstNumber(diag.indicesOk, indexRows.length ? indexRows.filter(([, count]) => number(count) > 0).length : null),
    attempted: firstNumber(diag.universeIndicesScanned, indexRows.length || null),
    failed: indexRows.filter(([, count]) => number(count) === 0).map(([name]) => name),
    missingSector, candidateMissingSector,
    mapped: registry ? firstNumber(summary.mapped, summary.mappedCount, summary.upstoxMapped, mappedRows.length) : null,
    unmapped: registry ? firstNumber(summary.unmapped, members.length - mappedRows.length) : null,
    mid: registry ? firstNumber(summary.mid, members.filter(row => row.marketCapBucket === 'mid').length) : null,
    small: registry ? firstNumber(summary.small, members.filter(row => row.marketCapBucket === 'small').length) : null,
    indexRows,
  };
}

// Rendering functions consume the same pure helpers used by Node tests.
const metric = (title, value, note, className = '') => `<div class="metric"><dl><dt>${e(title)}</dt><dd class="${className}">${e(value)}</dd></dl><p class="small">${e(note)}</p></div>`;
const field = (title, value) => `<div><dt>${e(title)}</dt><dd>${e(value)}</dd></div>`;
const heading = (eyebrow, title, description, badge = '') => `<div class="section-heading"><div><p class="eyebrow">${e(eyebrow)}</p><h1>${e(title)}</h1><p class="muted">${e(description)}</p></div>${badge ? `<span class="badge">${e(badge)}</span>` : ''}</div>`;
const empty = (title, body) => `<div class="empty"><h2>${e(title)}</h2><p class="muted">${e(body)}</p></div>`;
const pill = row => `<span class="badge ${['Watch','Simulated pick'].includes(row.status) ? 'watch' : 'warning'}">${e(row.status)}</span>`;
const list = values => `<ul>${values.map(value => `<li>${e(value)}</li>`).join('')}</ul>`;
const expiryText = row => row.expiresAt ? `${row.expired ? 'Expired' : 'Expires'} ${dateTime(row.expiresAt)}${row.expiryInferred ? ' · session end inferred' : ''}` : 'Setup expiry not supplied';

function suggestionDetails(row) {
  return `<details><summary>Research details for ${e(row.ticker)}</summary><div class="details-body">
    <p><strong>Entry lane:</strong> ${e(row.lane ?? 'Not supplied; qualification not established')}</p>
    <p><strong>Registry:</strong> Sector ${e(row.sector ?? NA)} · market-cap bucket ${e(row.marketCapBucket ?? NA)} · mapping ${e(row.mappingStatus ?? NA)}. Registry membership does not establish trade eligibility.</p>
    <p><strong>Current observation:</strong> ${e(row.chosenSource)} · ${e(dateTime(row.chosenAt))}</p>
    <p><strong>Current recorded blockers${row.usesDaily ? '' : ' (scans.missing)'}:</strong></p>${row.reasons.length ? list(row.reasons) : '<p>No blockers recorded. This does not establish qualification.</p>'}
    ${row.usesDaily && row.scanReasons.length ? `<p><strong>Older scan blockers (scans.missing) · ${e(dateTime(row.scanAt))}:</strong></p>${list(row.scanReasons)}` : ''}
    ${row.laneReasons.length ? `<p><strong>Recorded lane reasons:</strong></p>${list(row.laneReasons)}` : '<p>Per-lane diagnostics not supplied.</p>'}
    ${row.dailyReason ? `<p><strong>Daily decision:</strong> ${e(row.dailyReason)}</p>` : ''}
    <dl class="key-values divider">${field('Latest scan discovery score', decimal(row.discoveryScore))}${field('Current model score', decimal(row.modelScore))}${field('Daily effective score', decimal(row.effectiveScore))}${field(row.accumulationSource, decimal(row.accumulation))}${field('Latest scan Flow score · separate signal', decimal(row.flowScore))}${field('Current relative volume', row.relVol === null ? NA : `${decimal(row.relVol)}×`)}${field('Catalyst verification', row.verification)}</dl>
    <p class="small divider">Scores are ranking signals, not probabilities. Accumulation is a volume/flow proxy, not proof of institutional buying.</p>
    <p class="small">Catalyst: ${e(row.catalyst)}. ${row.status==='Simulated pick'?'A simulated fill was recorded; no real broker order was placed.':row.preliminary ? 'scan.tradeable is true: preliminary scan only; no entry is authorized.' : 'Research alone is not a fill; the deterministic engine must confirm an entry.'}</p>
    <dl class="key-values divider">${field('Saved quote', money(row.price))}${field('VWAP', money(row.vwap))}${field('Trigger', money(row.trigger))}${field('Stop', money(row.stop))}</dl>
    <p class="small divider">Quote: ${e(row.priceSource)} · ${e(dateTime(row.priceAt))}. Saved quote is not a fill or a live executable price.</p>
    ${row.daily ? `<p class="small">Daily considered: ${e(dateTime(row.dailyAt))} · daily-pick.json / main branch</p>` : ''}
    ${row.candidate ? `<p class="small">Latest scan: ${e(dateTime(row.scanAt))} · intraday-candidates.json / main branch · ${asArray(row.candidate.scans).length} recorded scans</p>` : ''}
    <p class="small">${e(expiryText(row))}</p>
  </div></details>`;
}
export function renderSuggestions(rows) {
  if (!rows.length) return empty('No matching suggestions', 'Change the filter or refresh files. Missing sources are listed in system health.');
  return `<div class="panel desktop-table"><table class="stock-table"><caption>Watchlist research · main branch · scores are not probabilities</caption><thead><tr><th scope="col">Stock / source</th><th scope="col">Status / setup time</th><th scope="col" class="number">Discovery score</th><th scope="col" class="number">Saved price</th><th scope="col" class="reason-column">Entry review</th></tr></thead><tbody>${rows.map(row => `<tr><td><strong>${e(row.ticker)}</strong><span class="cell-note">${e(row.name)}</span><span class="cell-note">${e(row.sector ?? 'Sector not available')}</span><span class="cell-note">${e(row.sources.join(' + '))}</span></td><td>${pill(row)}<span class="cell-note">${e(row.chosenSource)} ${e(dateTime(row.chosenAt))}</span><span class="cell-note">${e(expiryText(row))}</span></td><td class="number">${e(decimal(row.discoveryScore))}<span class="cell-note">Latest scan · ${e(dateTime(row.scanAt))}</span></td><td class="number">${e(money(row.price))}<span class="cell-note">${e(row.priceSource)}</span><span class="cell-note">${e(dateTime(row.priceAt))}</span></td><td>${e(row.currentReason)}${suggestionDetails(row)}</td></tr>`).join('')}</tbody></table></div>
    <div class="panel mobile-cards">${rows.map(row => `<article class="stock-card"><header><div><h2>${e(row.ticker)}</h2><p class="muted small">${e(row.name)}</p><p class="small muted">${e(row.sector ?? 'Sector not available')}</p></div>${pill(row)}</header><p class="small muted">${e(row.sources.join(' + '))} · main branch</p><p class="small muted">${e(row.chosenSource)} ${e(dateTime(row.chosenAt))}</p><p class="small muted">${e(expiryText(row))}</p><dl class="key-values">${field('Saved price', money(row.price))}${field('Latest scan discovery score · not probability', decimal(row.discoveryScore))}${field('VWAP', money(row.vwap))}${field('Trigger / stop', `${money(row.trigger)} / ${money(row.stop)}`)}</dl><p>${e(row.currentReason)}</p>${suggestionDetails(row)}</article>`).join('')}</div>`;
}

export function simulationSuggestions(sim, now=Date.now()) {
  const rows=new Map((sim?.suggestions||[]).map(r=>[r.ticker,r]));
  const today=new Date(now+19800000).toISOString().slice(0,10);
  // Held names leave discovery. Keep today's actual simulated picks visible instead
  // of making them disappear from Suggestions on the very next five-minute scan.
  for(const p of [...(sim?.positions||[]),...(sim?.trades||[])])if((p.date||p.entryDate)===today){
    rows.set(p.ticker,{...rows.get(p.ticker),ticker:p.ticker,fullName:p.fullName,sector:p.sector,
      status:'simulated-buy',price:p.currentPrice,observedAt:p.lastPriceUpdate,pickedAt:p.addedAt,
      setup:p.setup,research:p.research,reasons:[p.exitAt?`Simulated pick; exited: ${p.exitReason}`:'Simulated fill recorded; position is managed by exit checks']});
  }
  return [...rows.values()].map(r=>({ticker:r.ticker,name:r.fullName||r.ticker,sector:r.sector,
    reasons:r.reasons||[],scanReasons:[],laneReasons:[],sources:['Upstox paper scan',...(r.research?[r.research.source||'Saved research']:[])],
    status:r.status==='simulated-buy'?'Simulated pick':r.status==='not-qualified'?'Not qualified':'Watch',
    chosenSource:r.status==='simulated-buy'?'Simulated fill':'Paper experiment',chosenAt:r.pickedAt||sim.updatedAt,currentReason:(r.reasons||[]).join('; ')||'Not selected in this scan',
    discoveryScore:r.discoveryScore,modelScore:null,effectiveScore:null,accumulation:null,flowScore:null,accumulationSource:'Not an institutional signal',
    relVol:r.setup?.volumeRatio??null,verification:r.research?.verification||'No verified event supplied',
    catalyst:r.research?`${r.research.type}: ${r.research.summary}`:'No positive-catalyst requirement; price/volume confirmation remains mandatory',
    price:r.price,priceAt:r.observedAt,priceSource:r.price==null?'No live premarket price claimed':'Saved Upstox observation',
    vwap:r.setup?.vwap??null,trigger:r.setup?.breakoutLevel??null,stop:null,
    expiresAt:sessionEnd(sim.updatedAt?.slice(0,10)),expiryInferred:true,expired:timestamp(sessionEnd(sim.updatedAt?.slice(0,10)))<now,
    preliminary:false,scanAt:sim.updatedAt,daily:null,candidate:null
  }));
}

function coverageCard(coverage) {
  return `<section class="panel panel-pad"><div class="inline-heading"><h2>Coverage health</h2><span class="badge warning">${coverage.failed.length || coverage.actualCount === null ? 'Incomplete / unknown' : 'Verify coverage'}</span></div><p class="muted small">Intended: official Nifty 500. Registry availability differs from snapshot coverage; detailed research has its own shortlist.</p>
    <dl class="key-values">${field('Available registry members', decimal(coverage.registryCount))}${field('Stocks in latest snapshot', decimal(coverage.actualCount))}${field('Upstox mappings in registry', decimal(coverage.mapped))}${field('Unmapped registry members', decimal(coverage.unmapped))}${field('Mid / small registry members', `${decimal(coverage.mid)} / ${decimal(coverage.small)}`)}${field('Successful index responses', decimal(coverage.indicesOk))}${field('Registry missing sector', decimal(coverage.missingSector))}${field('Suggestions missing sector', decimal(coverage.candidateMissingSector))}</dl>
    <p class="small divider">${coverage.attempted === null ? 'Index attempts not supplied.' : `${e(coverage.attempted)} index attempts; attempts are not successes.`} ${coverage.failed.length ? `${coverage.failed.length} empty index responses.` : ''} Unmapped entries can include official placeholders and membership mismatches; membership is not trade eligibility.</p>
    ${coverage.failed.length ? `<details><summary>Empty / failed index coverage</summary>${list(coverage.failed)}</details>` : ''}
  </section>`;
}
function evidenceCard(trades) {
  const momentum = laneEvidence(trades, 'momentum'), catalyst = laneEvidence(trades, 'catalyst');
  return `<section class="panel panel-pad"><div class="inline-heading"><h2>Legacy edge evidence</h2><span class="badge warning">Paused for review</span></div>
    <p>${trades === null ? 'Closed-trade evidence is unavailable.' : `Momentum: ${e(percent(momentum.meanNetPct))} average closed-trade result after a 30bp cost estimate, from ${momentum.count} eligible historical samples. Catalyst: ${catalyst.count} eligible samples; evidence is limited.`}</p>
    <p class="small muted">As of ${e(momentum.asOf)} (excludes same-day exits). Shared evidence rules exclude synthetic, voided, backdated and duplicate trades. Historical paper results contain mixed / unknown strategy versions; these are old results, not performance of the new strategy. The review pause is not a live engine status. No validated forecast or portfolio return is implied.</p>
  </section>`;
}
function renderOverview(data, suggestions, ledger, coverage) {
  const pick = data['daily-pick']?.pick;
  if(data['paper-simulation']){
    const sim=data['paper-simulation'],today=new Date(Date.now()+19800000).toISOString().slice(0,10),day=sim.days?.[today];
    const latestPick=[...(sim.positions||[]),...(sim.trades||[])].sort((a,b)=>(timestamp(b.addedAt)??0)-(timestamp(a.addedAt)??0))[0];
    const equity=number(sim.cash)===null?null:sim.cash+(sim.positions||[]).reduce((s,p)=>s+(p.shares*p.currentPrice||0),0);
    return heading('Experimental portfolio','Overview','₹10,000 per trading day · price/volume setups · no real orders','Paper only')+
      `<div class="metrics">${metric('Simulated realized P&L',money(ledger.gross),'Before estimated costs',tone(ledger.gross))}${metric('Realized after estimated costs',money(ledger.estimatedNet),'From recorded simulated fills',tone(ledger.estimatedNet))}${metric('Daily investment remaining',money(Math.max(0,10000-(day?.invested||0))),'Costs included · unused budget is not a buy signal')}${metric('Open positions',decimal(ledger.openCount),'At most five open; three new per day')}</div>`+
      `<div class="two-column"><section class="panel panel-pad"><h2>Simulation account</h2><dl class="key-values">${field('Hypothetical cash',money(sim.cash))}${field('Hypothetical contributions',money(sim.contributions))}${field('Cash + marked positions',money(equity))}${field('Version',sim.strategyVersion)}</dl><p class="small divider">₹10,000 hypothetical funding is added once on each trading day when the first market-hours check runs. Unspent cash carries forward, but new investment remains capped at ₹10,000/day.</p><p class="small">Research suggestions refresh every five minutes from 08:00 IST. Entry AND exit checks run every five minutes from 09:15 to 15:25 IST. Entries are evidence-led, not held until 10:00; completed opening-range confirmation is still required. Modeled initial risk ₹100/trade, at most ₹500 open risk. Gaps can exceed these estimates. No fixed profit target or guaranteed daily return.</p><p class="small">${sim.updatedAt?`Last state update: ${e(dateTime(sim.updatedAt))}`:'Waiting for the first scheduled research check; no trades have been invented.'}</p></section>${coverageCard(coverage)}</div>`+
      `<section class="panel panel-pad"><h2>Suggestions + picks</h2><p>${e(latestPick?`Latest simulated pick: ${latestPick.ticker} · ${dateTime(latestPick.addedAt)}`:sim.suggestions?.length?'No pick yet. Review the current research suggestions and their recorded blockers.':'No research suggestions yet. Fresh saved morning/news research is checked from 08:00 IST; Upstox momentum is checked after the market opens.')}</p><a class="text-link" href="#suggestions">Review suggestions →</a><p class="small">This version is collecting its own evidence. Legacy results remain archived and are not presented as validation of this experiment. Cost assumption: 15bp per side; additional 5bp execution slippage per side plus observed bid/ask spread.</p></section>`;
  }
  return heading('Your working desk', 'Overview', 'Review the queue, paper positions and data quality.', 'Paper only') +
    `<div class="metrics">${metric('Realized paper P&L', money(ledger.gross), ledger.missingRealized ? `Partial: ${ledger.missingRealized} amounts missing · before costs` : 'Recorded rupee sum · before costs', tone(ledger.gross))}${metric('Open unrealized P&L', money(ledger.unrealized), ledger.openCount === null ? 'Position source unavailable' : `${ledger.openCount} open positions${ledger.missingOpen ? ` · ${ledger.missingOpen} unpriced` : ''}`, tone(ledger.unrealized))}${metric('Closed trades / wins', ledger.count === null ? NA : `${ledger.count} / ${ledger.wins}`, 'Mixed / unknown strategy versions')}${metric('Research queue', suggestions.length ? decimal(suggestions.length) : data['daily-pick'] || data['intraday-candidates'] ? '0' : NA, 'Daily + intraday · deduplicated')}</div>
    <div class="grid"><div><section class="panel panel-pad"><div class="inline-heading"><h2>Latest daily decision</h2><span class="badge ${pick?.noTrade ? 'warning' : ''}">${pick ? pick.noTrade ? 'No entry qualified' : 'Review only' : 'Unavailable'}</span></div><p>${e(pick?.reason ?? 'Decision not supplied. Check file health.')}</p><p class="small muted">${e(dateTime(pick?.pickedAt ?? pick?.date))} · main branch</p><p class="small muted">Regime: ${e(pick?.regime ?? NA)}. Momentum lane: ${pick?.momLaneOpen === false ? 'closed in saved decision' : pick?.momLaneOpen === true ? 'open in saved decision; entry still requires review' : NA}.</p><a class="text-link" href="#suggestions">Review suggestions →</a></section>${evidenceCard(data.realized?.trades ?? null)}</div><div>${coverageCard(coverage)}<section class="panel panel-pad"><h2>Paper ledger</h2><dl class="key-values">${field('Realized + open, before costs', money(ledger.combined))}${field('Estimated closed-trade costs', money(ledger.estimatedCosts))}</dl><p class="small muted divider">Cost estimate: 30bp × recorded invested amount (or shares × entry), on ${ledger.costCount} closed trades. No capital history: no portfolio return, alpha or CAGR. No allocation assumed.</p><a class="text-link" href="#results">Inspect results →</a></section></div></div>`;
}
export function renderPositions(positions, ledger) {
  const intro = heading('Paper ledger', 'Positions', 'Open paper positions valued only from recorded shares, entry and current price.');
  if (positions === null) return intro + empty('Positions unavailable', 'project-bouquet.json could not be read. No position count or value can be inferred.');
  if (!positions.length) return intro + empty('No open paper positions', 'The saved position file contains an empty bouquet. Watching a stock does not create a position.');
  const fields = row => `${field('Shares', decimal(row.shares))}${field('Entry', money(row.entryPrice))}${field('Recorded current price', money(row.currentPrice))}${field('Unrealized · before costs', money(positionAmount(row)))}${field('Trigger', money(row.triggerPrice))}${field('Stop', money(row.trailingStopPrice ?? row.initialStopPrice ?? row.stopPrice))}`;
  return intro + `<p class="notice">Open unrealized: ${e(money(ledger.unrealized))}${ledger.missingOpen ? ` · Partial: ${ledger.missingOpen} positions lack shares or prices.` : ' · Before costs.'} Prices are saved observations.</p><div class="panel desktop-table"><table class="stock-table"><caption>Source: project-bouquet.json / main branch</caption><thead><tr><th scope="col">Stock</th><th scope="col">Shares</th><th scope="col">Entry / current</th><th scope="col">Trigger / stop</th><th scope="col">Unrealized</th></tr></thead><tbody>${positions.map(row => `<tr><td><strong>${e(row.ticker)}</strong><span class="cell-note">${e(dateTime(row.lastPriceUpdate))}</span></td><td>${e(decimal(row.shares))}</td><td>${e(money(row.entryPrice))} / ${e(money(row.currentPrice))}</td><td>${e(money(row.triggerPrice))} / ${e(money(row.trailingStopPrice ?? row.initialStopPrice ?? row.stopPrice))}</td><td class="${tone(positionAmount(row))}">${e(money(positionAmount(row)))}</td></tr>`).join('')}</tbody></table></div><div class="panel mobile-cards">${positions.map(row => `<article class="stock-card"><h2>${e(row.ticker)}</h2><p class="small muted">Quote observed: ${e(dateTime(row.lastPriceUpdate))} · main branch</p><dl class="key-values">${fields(row)}</dl></article>`).join('')}</div>`;
}
export function renderResults(trades, ledger, {experimental=false}={}) {
  const intro = heading('Closed paper ledger', 'Results', 'Recorded rupee results, with estimated costs shown separately.');
  if (trades === null) return intro + empty('Results unavailable', 'realized.json could not be read. Missing results are not zero returns.');
  const cost = row => number(row.estimatedCostAmount) ?? (investedBasis(row) === null ? null : investedBasis(row) * 0.003);
  return intro + `<div class="metrics">${metric('Realized · before costs', money(ledger.gross), ledger.missingRealized ? `Partial: ${ledger.missingRealized} missing amounts` : `${ledger.count} recorded trades`, tone(ledger.gross))}${metric('Estimated costs', money(ledger.estimatedCosts), `Recorded cost scenario · ${ledger.costCount}/${ledger.count} trades`)}${metric('Realized after estimated costs', money(ledger.estimatedNet), 'Estimate, not a broker reconciliation', tone(ledger.estimatedNet))}${metric('Wins / closed trades', `${ledger.wins} / ${ledger.count}`, `${ledger.losses} losses · before estimated costs`)}</div><p class="notice warning">${experimental?'Experimental paper-breakout-v1 only. No legacy trades are mixed into these results. Costs use 15bp per side; fill prices additionally include 5bp slippage per side and the observed bid/ask spread. These are estimates, not actual broker charges. No daily profit is guaranteed.':'Mixed / unknown strategy versions. Historical results do not validate the current entry rules. No capital history is supplied, so portfolio return, alpha and CAGR are unavailable. The cost estimate is 30bp of known invested capital per closed trade, not an actual fee breakdown.'}</p>
    ${!trades.length ? empty('No closed paper trades', 'The source ledger contains no closed trades.') : `<div class="panel desktop-table"><table class="stock-table"><caption>Source: realized.json / main branch · newest exit first</caption><thead><tr><th scope="col">Stock / lane</th><th scope="col">Entry → exit</th><th scope="col" class="number">Realized ₹</th><th scope="col" class="number">Est. costs ₹</th><th scope="col">Exit reason / version</th></tr></thead><tbody>${sortedTrades(trades).map(row => `<tr><td><strong>${e(row.ticker)}</strong><span class="cell-note">${e(row.entryLane ?? 'Lane unknown')}</span></td><td>${e(row.entryDate ?? NA)} → ${e(row.exitDate ?? NA)}<span class="cell-note">${e(money(row.entryPrice))} → ${e(money(row.exitPrice))} · ${e(decimal(row.shares))} shares</span></td><td class="number ${tone(realizedAmount(row))}">${e(money(realizedAmount(row)))}</td><td class="number">${e(money(cost(row)))}</td><td>${e(row.exitReason ?? NA)}<span class="cell-note">${e(row.strategyVersion ?? 'Version unknown')}</span></td></tr>`).join('')}</tbody></table></div><div class="panel mobile-cards">${sortedTrades(trades).map(row => `<article class="stock-card"><header><div><h2>${e(row.ticker)}</h2><p class="small muted">${e(row.entryLane ?? 'Lane unknown')} · ${e(row.exitDate ?? NA)}</p></div><strong class="${tone(realizedAmount(row))}">${e(money(realizedAmount(row)))}</strong></header><dl class="key-values">${field('Entry → exit', `${money(row.entryPrice)} → ${money(row.exitPrice)}`)}${field('Estimated costs · 30bp', money(cost(row)))}${field('Shares', decimal(row.shares))}${field('Strategy version', row.strategyVersion ?? 'Unknown')}</dl><details><summary>Exit details for ${e(row.ticker)}</summary><p>${e(row.exitReason ?? NA)}</p><p class="small muted">Entry: ${e(row.entryDate ?? NA)} · Exit: ${e(row.exitDate ?? NA)} · main branch</p></details></article>`).join('')}</div>`}`;
}
const sortedTrades = trades => [...trades].sort((a, b) => (timestamp(b.exitAt ?? b.exitDate) ?? 0) - (timestamp(a.exitAt ?? a.exitDate) ?? 0));

export function renderHealth(states, coverage, now = Date.now()) {
  return `<p class="small muted">Remote files are read from public main branch without credentials. Failed reads are unavailable; there is no silent local fallback. A source timestamp may describe an observation rather than file publication.</p><div class="health-files">${states.map(state => {
    const time = state.data ? sourceTime(state.name, state.data) : { value: null, kind: 'No source time' };
    const age = freshness(time.value, now);
    return `<article class="file-row"><header><strong>${e(state.name)}.json</strong><span class="badge ${state.error || age.stale ? 'warning' : ''}">${e(state.error ? 'Unavailable' : age.label)}</span></header><p class="small"><a class="text-link" href="${e(state.url)}">${e(state.label)} · source JSON ↗</a></p>${state.error ? `<p>${e(state.error)}. Refresh files to retry.</p>` : `<p class="small">${e(time.kind)}: ${e(dateTime(time.value))}</p><p class="small">Fetched: ${e(dateTime(state.loadedAt))}. This is retrieval time, not data age.</p>`}</article>`;
  }).join('')}</div><div class="divider">${coverageCard(coverage)}</div>`;
}

async function fetchSource(source) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const url = `${source.url}?_=${Date.now()}`;
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = validateData(source.name, await response.json());
    return { ...source, data, loadedAt: new Date().toISOString(), error: null };
  } catch (error) {
    return { ...source, data: null, loadedAt: new Date().toISOString(), error: error.name === 'AbortError' ? 'Read timed out after 15 seconds' : `Read failed: ${error.message}` };
  } finally { clearTimeout(timeout); }
}

export function startDesk(doc = document, win = window) {
  let suggestions = [];
  const $ = id => doc.getElementById(id);
  const tabNames = ['overview', 'suggestions', 'positions', 'results'];
  const tabs = tabNames.map(name => $(`tab-${name}`));
  let active = 'overview';
  function selectTab(name, focus = false) {
    active = tabNames.includes(name) ? name : 'overview';
    for (const key of tabNames) {
      const tab = $(`tab-${key}`), selected = key === active;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      $(key).hidden = !selected;
    }
    if (focus) $(`tab-${active}`).focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { win.location.hash = tabNames[index]; selectTab(tabNames[index]); });
    tab.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault(); win.location.hash = tabNames[next]; selectTab(tabNames[next], true);
    });
  });
  function route() {
    const target = win.location.hash.slice(1);
    if (tabNames.includes(target)) selectTab(target);
    if (target === 'system-health') { $('system-health').open = true; $('system-health').scrollIntoView({ block: 'start' }); }
  }
  win.addEventListener('hashchange', route);
  // The health link also opens details when the hash already points at it.
  doc.querySelectorAll('a[href="#system-health"]').forEach(link => link.addEventListener('click', () => { $('system-health').open = true; }));
  const themeKey = 'stockdesk-preview-theme';
  function setTheme(theme) {
    doc.documentElement.dataset.theme = theme;
    $('theme-toggle').setAttribute('aria-pressed', String(theme === 'dark'));
    $('theme-toggle').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  }
  try { setTheme(win.localStorage.getItem(themeKey) === 'dark' ? 'dark' : 'light'); } catch { setTheme('light'); }
  $('theme-toggle').addEventListener('click', () => {
    const next = doc.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(next); try { win.localStorage.setItem(themeKey, next); } catch { /* Storage is optional. */ }
  });
  function filterSuggestions() {
    const query = $('stock-search').value.trim().toLowerCase(), status = $('status-filter').value;
    const filtered = suggestions.filter(row => (!query || `${row.ticker} ${row.name}`.toLowerCase().includes(query)) && (status === 'all' || row.status === status));
    $('suggestion-list').innerHTML = renderSuggestions(filtered);
    $('suggestion-count').textContent = `${filtered.length} of ${suggestions.length} stocks`;
  }
  $('stock-search').addEventListener('input', filterSuggestions);
  $('status-filter').addEventListener('change', filterSuggestions);
  async function refresh() {
    $('refresh').disabled = true; $('refresh').textContent = 'Reading files…';
    $('main').setAttribute('aria-busy', 'true');
    $('load-status').textContent = 'Reading public main branch data and local registry…';
    const states = await Promise.all(SOURCES.map(fetchSource));
    const data = Object.fromEntries(states.map(state => [state.name, state.data]));
    const sim=data['paper-simulation'];
    suggestions = sim ? simulationSuggestions(sim) : [];
    const trades = sim?.trades ?? null, positions = sim?.positions ?? null;
    const ledger = summarizeLedger(trades, positions), coverage = coverageSummary(data['nse-snapshot'], data.universe, suggestions);
    $('overview').innerHTML = sim?renderOverview(data, suggestions, ledger, coverage):empty('Simulation state unavailable','The new paper ledger could not be read. This is not a zero balance or a successful scan. Check file health.');
    $('positions').innerHTML = renderPositions(positions, ledger);
    $('results').innerHTML = renderResults(trades, ledger,{experimental:!!sim});
    $('suggestion-context').textContent = 'Suggestions + simulated picks: saved morning/news research before the open, then Upstox momentum checks every five minutes. Only “Simulated pick” means a fill was recorded. Advisor news is not automatically verified. Scores are rankings, not win probabilities.';
    const failed = states.filter(state => state.error).length;
    const stale = states.filter(state => state.data && freshness(sourceTime(state.name, state.data).value).stale).length;
    $('health-summary').textContent = `${failed} unavailable · ${stale} stale / age unknown`;
    $('health-content').innerHTML = renderHealth(states, coverage);
    $('load-status').textContent = `Main branch + local registry · ${states.length - failed}/${states.length} files read · ${failed} unavailable · ${stale} stale / age unknown`;
    filterSuggestions(); selectTab(active); route();
    $('main').setAttribute('aria-busy', 'false');
    $('refresh').disabled = false; $('refresh').textContent = 'Refresh files';
  }
  $('refresh').addEventListener('click', refresh);
  route();
  return refresh();
}
if (typeof document !== 'undefined' && document.getElementById('tab-overview')) startDesk();
