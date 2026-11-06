// Preregistered exit comparison. No fixed profit targets. Freeze this at ENTRY;
// future policy/ATR changes must not widen an existing position's protection.
import {researchExitObservation,CONSERVATIVE_EXIT} from './paper-plan.js';
export const EXIT_PROFILES=Object.freeze({
  'compression-breakout':Object.freeze({activationR:1.5,trailR:1}),
  'trend-pullback':Object.freeze({activationR:2,trailR:1.5}),
  'catalyst-continuation':Object.freeze({activationR:2,trailR:1.5})});
export function setupExitPolicy(type,{mode='baseline',entryPrice,initialStopPrice,atr14Pct,costBps=30}={}){
  if(!['baseline','setup-risk','setup-volatility'].includes(mode))throw Error('Unknown exit experiment');
  const p=mode==='baseline'?CONSERVATIVE_EXIT:EXIT_PROFILES[type];
  if(!p)throw Error('Unknown setup exit profile');
  if(!Number.isFinite(entryPrice)||!Number.isFinite(initialStopPrice)||!(entryPrice>initialStopPrice&&initialStopPrice>0)
    ||!Number.isFinite(costBps)||costBps<0)throw Error('Invalid frozen entry risk');
  let trailR=p.trailR;
  if(mode==='setup-volatility'){
    if(typeof atr14Pct!=='number'||!Number.isFinite(atr14Pct)||atr14Pct<=0)throw Error('ATR14 required for volatility exit experiment');
    trailR=Math.min(2,Math.max(trailR,entryPrice*atr14Pct/200/(entryPrice-initialStopPrice)));
  }
  return {version:'setup-exits-v1',mode,setupType:type??'original-consolidation',activationR:p.activationR,
    trailR,roundTripCostBps:costBps,atr14Pct:mode==='setup-volatility'?atr14Pct:null};
}
export function observeSetupExit(position,quote,options){
  const policy=position.exitPolicy;
  if(!policy)return researchExitObservation(position,quote,options);
  if(policy.version!=='setup-exits-v1'||!['baseline','setup-risk','setup-volatility'].includes(policy.mode)
    ||!Number.isFinite(policy.activationR)||!(policy.activationR>0)||!Number.isFinite(policy.trailR)||!(policy.trailR>0)||policy.trailR>2
    ||!Number.isFinite(policy.roundTripCostBps)||policy.roundTripCostBps<0)
    return {...researchExitObservation(position,quote,options),policyWarning:'invalid saved exit policy: conservative original protection retained'};
  return researchExitObservation(position,quote,{...options,config:policy});
}
