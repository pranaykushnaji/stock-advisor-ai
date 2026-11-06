// Pure read-only reporting. Entry setup and event evidence are separate dimensions.
import {BASELINE_SIM_CONFIG,SIM_CONFIG,MULTI_SETUP_CONFIG} from './paper-policy.js';
import {SETUP_TYPES} from './trading-setups.js';
import {replayPointInTimeEntries} from './point-in-time-entry-replay.js';
export const SETUP_SCENARIOS=Object.freeze([
  {mode:'original-breakout',config:BASELINE_SIM_CONFIG},
  {mode:'confirmed-breakout',config:SIM_CONFIG},
  {mode:'three-setups-original-exits',config:{...MULTI_SETUP_CONFIG,exitMode:'baseline'}},
  {mode:'three-setups-risk-exits',config:MULTI_SETUP_CONFIG},
  {mode:'three-setups-volatility-exits',config:{...MULTI_SETUP_CONFIG,exitMode:'setup-volatility'}},
  ...SETUP_TYPES.map(type=>({mode:type,config:{...MULTI_SETUP_CONFIG,allowedSetupTypes:[type]}}))]);
export function setupPerformance(state){
  const groups=new Map();
  for(const p of [...(state.positions||[]),...(state.trades||[])]){
    const setup=p.setupType||'original-consolidation',cohort=p.researchCohort||'price-only',key=setup+'|'+cohort;
    const g=groups.get(key)||{setup,cohort,entries:0,closed:0,open:0,closedWins:0,capital:0,realizedNet:0,
      openMarkedAfterEntryCosts:0,closedReturns:[],exitReasons:{}};
    g.entries++;g.capital+=p.investedAmount;
    if(p.exitAt){g.closed++;g.realizedNet+=p.realizedNetPnl;g.closedWins+=p.realizedNetPnl>0?1:0;
      g.closedReturns.push(p.realizedNetPnl/p.investedAmount*100);
      g.exitReasons[p.exitReason]=(g.exitReasons[p.exitReason]||0)+1;
    }else{g.open++;if(Number.isFinite(p.currentPrice))g.openMarkedAfterEntryCosts+=(p.currentPrice-p.entryPrice)*p.shares-p.entryCost;}
    groups.set(key,g);
  }
  return [...groups.values()].map(({closedReturns,...g})=>({...g,
    closedWinRatePct:g.closed?g.closedWins/g.closed*100:null,
    averageClosedReturnPct:closedReturns.length?closedReturns.reduce((s,x)=>s+x,0)/closedReturns.length:null,
    bestClosedReturnPct:closedReturns.length?Math.max(...closedReturns):null,
    worstClosedReturnPct:closedReturns.length?Math.min(...closedReturns):null,
    weightedMarkedReturnPct:g.capital?(g.realizedNet+g.openMarkedAfterEntryCosts)/g.capital*100:null}));
}
export function compareSetupExperiments(records){
  const report=replayPointInTimeEntries(records,{scenarios:SETUP_SCENARIOS});
  return {...report,variants:report.variants.map(({state,...v})=>({...v,
    entries:state.positions.length+state.trades.length,groups:setupPerformance(state),
    finalBlockers:state.suggestions.map(s=>({ticker:s.ticker,reasons:s.reasons,
      lanes:s.setupReview?.lanes.map(l=>({type:l.type,status:l.status,missingConfirmation:l.missingConfirmation}))??null}))})),
    limitations:[...report.limitations,'No outcomes are backfilled when point-in-time frames are absent.',
      'Open marks are not liquidated fills and exclude future exit costs.',
      'Observed shortlist coverage is not full-universe rediscovery. Rotation needs forward paper collection.',
      'Frozen risk/ATR profiles are preregistered hypotheses, not fitted to recent winners.',
      'The same recorded scan frames are used for each variant; missing intervening risk ticks are not fabricated.']};
}
