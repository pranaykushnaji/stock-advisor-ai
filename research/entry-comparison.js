// Isolated standardized one-share comparison. No account writes, optimization or
// automatic threshold tuning. Session marks are not multi-day strategy returns.
import {replayPaperSession} from './session-replay.js';
import {BASELINE_SIM_CONFIG,SIM_CONFIG} from './paper-policy.js';
import {ENTRY_VARIANTS,ENTRY_QUALITY,researchCohort} from './entry-quality.js';
const round=n=>Math.round(n*100)/100;
function summarize(rows){
  const capital=rows.reduce((s,r)=>s+r.capital,0),net=rows.reduce((s,r)=>s+r.net,0);
  return {entries:rows.length,closed:rows.filter(r=>r.closed).length,positive:rows.filter(r=>r.net>0).length,
    negative:rows.filter(r=>r.net<0).length,capital:round(capital),netAfterEstimatedLiquidationCosts:round(net),
    weightedReturnPct:capital>0?net/capital*100:null,averageStockReturnPct:rows.length?rows.reduce((s,r)=>s+r.pct,0)/rows.length:null,
    bestReturnPct:rows.length?Math.max(...rows.map(r=>r.pct)):null,worstReturnPct:rows.length?Math.min(...rows.map(r=>r.pct)):null};
}
export function compareEntryVariants(sessions,{generatedAt=new Date().toISOString(),scenarios=null}={}){
  const variants=(scenarios??ENTRY_VARIANTS.map(mode=>({mode,config:mode==='baseline'?BASELINE_SIM_CONFIG:{...SIM_CONFIG,entryMode:mode}}))).map(({mode,config})=>{
    const results=sessions.map(input=>{
      const replay=replayPaperSession({...input,config,generatedAt});
      const rows=[...replay.trades,...replay.positions].map(p=>{
        // Open marks include an explicit hypothetical liquidation spread/slip and
        // both-side fees, not a fictitious closed trade in the real account.
        const liquidation=p.currentPrice*(1-15/10000)*(1-config.exitSlippageBps/10000);
        const net=p.exitAt?p.realizedNetPnl:liquidation*p.shares*(1-config.costBpsPerSide/10000)-p.investedAmount-p.entryCost;
        return {ticker:p.ticker,date:input.date,closed:!!p.exitAt,capital:p.investedAmount,net,pct:net/p.investedAmount*100,
          setup:p.setupType||'original-consolidation',cohort:p.researchCohort||researchCohort(p.research,new Date(p.addedAt)),entryAt:p.addedAt,
          exitAt:p.exitAt??null,reason:p.exitReason??'session mark, not executed liquidation'};
      });
      const missing=Object.entries(input.series||{}).filter(([,s])=>!s?.candles?.length).map(([t])=>t);
      const sufficient=!!input.benchmark?.candles?.length&&!!input.scans?.length&&!missing.length&&!Object.keys(input.source?.historyFailures||{}).length;
      return {date:input.date,status:sufficient?'estimated':'incomplete',source:input.source??null,missing,
        summary:summarize(rows),cohorts:Object.fromEntries(['research-backed','price-only'].map(c=>[c,summarize(rows.filter(r=>r.cohort===c))])),
        rows,rejectionCounts:replay.checks.flatMap(c=>c.rejected).reduce((a,r)=>{for(const why of r.reasons)a[why]=(a[why]||0)+1;return a;},{})};
    });
    const rows=results.flatMap(r=>r.rows);
    return {mode,summary:summarize(rows),cohorts:Object.fromEntries(['research-backed','price-only'].map(c=>[c,summarize(rows.filter(r=>r.cohort===c))])),
      setups:Object.fromEntries([...new Set(rows.map(r=>r.setup))].map(t=>[t,summarize(rows.filter(r=>r.setup===t))])),sessions:results};
  });
  return {version:1,mode:'isolated-entry-comparison',generatedAt,rules:ENTRY_QUALITY,variants,
    validationStatus:sessions.length>=20?'requires chronological out-of-sample review':'INSUFFICIENT SESSIONS — diagnostic only, not profit validation',
    limitations:['Uses original timestamped opportunity lists; not complete historical rediscovery.',
      'One share per name, independent daily studies starting without inherited positions; not an overnight portfolio backtest.',
      'Historical candle revisions/cross-provider differences, assumed 30bp spread, 5bp slippage and 15bp fee per side.',
      'Historical depth and execution-time circuit checks remain unverified; simulated eligibility is not proof of a real fill.',
      'Previously observed pending signals are retained for fifteen minutes; missing later shortlist quotes use modeled completed-minute closes.',
      'Open positions marked with hypothetical liquidation costs; no sale or retrospective buy is added to any account.',
      'Missing data is not a winning no-trade session. No automatic selection of best-looking thresholds.',
      'Fees are modeled estimates, not a broker contract-note calculation.']};
}
