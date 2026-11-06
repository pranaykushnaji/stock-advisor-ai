// Recover ONLY measurements already present in the original decision commit.
// Never fetch current candles or infer missing historical bid/ask from the fill.
export function recoverDecisionEvidence(position,state,sourceCommit){
  const entryAt=position.addedAt||position.entryAt;
  const saved=[...(state.positions||[]),...(state.trades||[])].find(p=>p.id===position.id&&(p.addedAt||p.entryAt)===entryAt);
  if(!saved||Date.parse(state.updatedAt)<Date.parse(entryAt))return null;
  if(saved.decisionEvidence?.version===1)return {...saved.decisionEvidence,auditSourceCommit:sourceCommit};
  const ref=state.dailyCache?.[saved.ticker],metrics={};
  const add=(key,label,value,unit,source,at)=>{if(typeof value==='number'&&Number.isFinite(value))
    metrics[key]={label,value,unit,status:'available',asOf:at,source,required:false};};
  const time=saved.setup?.signalAt||entryAt;
  add('executionPrice','Original recorded paper fill',saved.entryPrice,'INR','Original paper trade',entryAt);
  add('initialStop','Frozen initial stop',saved.initialStopPrice,'INR','Original paper trade',entryAt);
  add('breakoutLevel','Original breakout level',saved.setup?.breakoutLevel,'INR','Original saved setup',time);
  add('vwap','Signal VWAP · OHLC approximation',saved.setup?.vwap,'INR','Original saved setup',time);
  add('breakoutVolumeRatio','Breakout volume / preceding range average',saved.setup?.volumeRatio,'×','Original saved setup',time);
  if(ref?.asOf===saved.date){
    const day=ref.lastSession?`${ref.lastSession}T15:30:00+05:30`:`${ref.asOf}T00:00:00+05:30`;
    add('ema20','20-session EMA at decision',ref.ema20,'INR','Original daily reference',day);
    add('averageTurnoverCr','20-session average traded value',ref.averageTurnoverCr,'₹ Cr','Original daily reference',day);
    add('prior5Pct','Prior 5 completed sessions',ref.return5Pct,'%','Original daily reference',day);
  }
  // The first scan that recorded this buy owns its benchmark; a later scan does not.
  if(state.lastCheck?.bought===saved.ticker&&state.lastCheck?.action==='scan'){
    const b=state.discovery?.benchmark;
    add('niftyDayReturnPct','Nifty change at entry scan',b?.changePct,'%','Original Upstox benchmark snapshot',b?.observedAt);
  }
  return {version:0,asOf:entryAt,metrics,readiness:null,auditSourceCommit:sourceCommit,
    scope:'Recovered original saved measurements; unrecorded execution-book fields remain unknown',
    notUsed:['Legacy composite / institutional scores','Calibrated probability of profit']};
}
