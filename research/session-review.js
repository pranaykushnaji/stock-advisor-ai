// Audit saved decisions, not a backtest. Never constructs retrospective purchases.
export function reviewPaperSession(states, date) {
  const scans = states.filter(s => s.lastCheck?.action === 'scan' && s.updatedAt?.startsWith(date))
    .sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt));
  const unique = [...new Map(scans.map(s=>[s.updatedAt,s])).values()];
  const candidates = new Map(), reasons = {}, cappedSetups = [];
  for(const s of unique) for(const row of s.suggestions||[]) {
    for(const why of row.reasons||[]) reasons[why]=(reasons[why]||0)+1;
    const remaining = Math.max(0,(s.config?.dailyInvestment??10000)-(s.days?.[date]?.invested??0));
    if(row.entryDiagnostics?.status==='setup' && row.reasons?.includes('three daily positions already opened')) {
      cappedSetups.push({ticker:row.ticker,at:row.observedAt,price:row.price,remaining,
        reasons:row.reasons,onlyRecordedBlocker:row.reasons.length===1,
        cannotAffordEvenAtLastPrice:row.price>remaining});
    }
    if(!(row.price>0)||!row.observedAt)continue;
    const c=candidates.get(row.ticker)||{ticker:row.ticker,firstAt:row.observedAt,firstPrice:row.price,prices:[],reasons:new Set()};
    c.lastAt=row.observedAt;c.lastPrice=row.price;c.prices.push(row.price);
    for(const why of row.reasons||[])c.reasons.add(why);
    candidates.set(row.ticker,c);
  }
  const last=unique.at(-1), rows=[...candidates.values()].map(({prices,reasons,...r})=>({...r,
    maxObservedRisePct:(Math.max(...prices)/r.firstPrice-1)*100,
    lastObservedReturnPct:(r.lastPrice/r.firstPrice-1)*100,observations:prices.length,reasons:[...reasons]}))
    .sort((a,b)=>b.maxObservedRisePct-a.maxObservedRisePct);
  return {date,scans:unique.length,distinctSuggestions:rows.length,
    benchmarkBlockedScans:unique.filter(s=>s.suggestions?.length&&s.suggestions.every(r=>r.reasons?.includes('benchmark price unavailable'))).length,
    benchmark:last?.discovery?.benchmark??null,day:last?.days?.[date]??null,
    buys:unique.filter(s=>s.lastCheck.bought).map(s=>({ticker:s.lastCheck.bought,at:s.updatedAt})),
    rejectionScanOccurrences:reasons,cappedSetups,candidates:rows,
    limitations:['Sampled suggestion-price rises are hindsight observations, not executable profits.',
      'Cap-only diagnostics do not establish full eligibility: sizing, circuit and risk checks may not have run.',
      'Reject counts are scan occurrences; the same stock may appear on many scans without being purchased again.']};
}
