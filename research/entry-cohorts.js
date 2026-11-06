// Read-only actual ledger analytics. Equal-stock and capital-weighted measures
// are separate. Open marks include PAID entry fees, not fictional exit fills.
import {researchCohort} from './entry-quality.js';
import {excludedFromPerformance,tradeNetAmount,entryCapital} from '../desk/performance.js';
export function entryCohortPerformance(state){
  const groups=new Map();
  for(const p of [...(state?.trades||[]),...(state?.positions||[])]){
    if(excludedFromPerformance(p))continue;
    const date=p.entryDate||p.date,at=new Date(p.entryAt||p.addedAt),capital=entryCapital(p);
    if(!date||!(capital>0)||!Number.isFinite(at.getTime()))continue;
    const cohort=p.researchCohort||researchCohort(p.research,at),key=date+'|'+cohort;
    const r=groups.get(key)||{date,cohort,entries:0,closed:0,closedPositive:0,closedNegative:0,
      openPositive:0,openNegative:0,capital:0,realizedNet:0,openMarkedAfterEntryCosts:0,returns:[]};
    r.entries++;r.capital+=capital;
    if(p.exitAt){const net=tradeNetAmount(p);if(net==null)continue;r.closed++;r.realizedNet+=net;
      if(net>0)r.closedPositive++;if(net<0)r.closedNegative++;r.returns.push(net/capital*100);
    }else if(p.currentPrice>0){const net=p.currentPrice*p.shares-capital-(p.entryCost||0);
      r.openMarkedAfterEntryCosts+=net;if(net>0)r.openPositive++;if(net<0)r.openNegative++;r.returns.push(net/capital*100);}
    groups.set(key,r);
  }
  return {asOf:state?.updatedAt,groups:[...groups.values()].map(({returns,...r})=>({...r,
    markedNet:r.realizedNet+r.openMarkedAfterEntryCosts,
    weightedMarkedReturnPct:(r.realizedNet+r.openMarkedAfterEntryCosts)/r.capital*100,
    equalStockMarkedReturnPct:returns.length?returns.reduce((s,n)=>s+n,0)/returns.length:null})),
    limitations:['Grouped by ENTRY date, not exit date. Open marked returns exclude future exit fees/slippage.',
      'Older records without fresh verified evidence are classified price-only; that does not prove no real news existed.',
      'Research-backed and price-only groups differ in selection; their returns alone do not prove news caused an advantage.']};
}
