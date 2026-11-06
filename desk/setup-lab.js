import {emptySimulation,transitionSimulation} from '../api/_paper-simulation.js';
import {MULTI_SETUP_CONFIG} from '../research/paper-policy.js';
import {renderSuggestions,simulationSuggestions} from './desk.js';
// Entirely fictional, public example inputs, not reconstructed historical trades.
export function setupExample(type){
  const open=Date.parse('2026-11-06T09:15:00+05:30'),at=new Date(open+40*60000+5000);
  const bars=type==='trend-pullback'?[
    [100,100.3,99.8,100.2,1200],[100.2,100.55,100.1,100.45,1300],
    [100.45,100.85,100.4,100.75,1400],[100.75,101.05,100.7,100.95,1500],
    [100.95,101.3,100.9,101.2,1600],[101.2,101.21,100.75,100.9,600],
    [100.9,101,100.8,100.88,500],[100.9,101.38,100.85,101.33,1800]]:[
    [100,100.2,99.6,100,1000],[100,100.2,99.65,100.01,1100],[100.01,100.2,99.7,100.02,1000],
    [100.02,100.18,99.8,100.03,900],[100.03,100.13,99.9,100.04,600],
    [100.04,100.13,99.92,100.05,650],[100.05,100.12,99.94,100.06,600],
    [100.08,100.6,100.05,100.55,2000]];
  const minutes=rows=>rows.flatMap((b,i)=>Array.from({length:5},(_,j)=>[new Date(open+i*300000+j*60000).toISOString(),...b.slice(0,4),b[4]/5]));
  const member={symbol:'SAMPLE',name:'Fictional setup example',sector:'Demonstration',instrumentKey:'NSE_EQ|DEMO',marketCapBucket:'mid'},price=bars.at(-1)[3]+.01;
  const q={...member,price,bidPrice:price-.02,askPrice:price+.02,spreadBps:4,previousClose:99,
    upperCircuit:120,lowerCircuit:80,dayHigh:102,dayLow:99,volume:10000,lastTradeAt:at.toISOString(),responseAt:at.toISOString()};
  const index={instrumentKey:'NSE_INDEX|Nifty 50',price:type==='weak-market'?99.8:100.08,previousClose:type==='weak-market'?98:100,responseAt:at.toISOString()};
  const research=type==='catalyst-continuation'?{verified:true,type:'Illustrative official order',eventPublishedAt:open-3600000,
    source:'Fictional demonstration event — not an actual filing',summary:'Example only; no real company event claimed.'}:null;
  const market={quotes:{[q.instrumentKey]:q,[index.instrumentKey]:index},candidates:[member],safetyReady:true,
    candles:{SAMPLE:minutes(bars)},references:{SAMPLE:{version:2,contextVersion:1,asOf:'2026-11-06',ema20:99,averageTurnoverCr:20,return5Pct:3,atr14Pct:2}},
    benchmarkCandles:minutes(Array.from({length:8},(_,i)=>[100+i*.01,100.02+i*.01,99.99+i*.01,100.01+i*.01,0])),
    researchBySymbol:research?{SAMPLE:research}:{}};
  const config={...MULTI_SETUP_CONFIG,allowedSetupTypes:[type==='weak-market'?'compression-breakout':type]};
  const result=transitionSimulation(emptySimulation(),market,{at,action:'scan',config});
  // Never present the throwaway example as an actual account fill.
  for(const p of [...result.state.positions,...result.state.trades])Object.assign(p,{synthetic:true,executed:false,excludeFromLiveStatistics:true});
  const decorated=new Set();
  for(const row of [...result.state.suggestions,...result.state.positions,...result.state.trades]){
    const evidence=row.decisionEvidence;if(!evidence||decorated.has(evidence))continue;decorated.add(evidence);
    evidence.scope='Fictional demonstration inputs; not actual provider observations';
    for(const metric of Object.values(evidence.metrics))metric.source='Fictional example · '+metric.source;
  }
  return {result,at};
}
if(typeof document!=='undefined'&&document.getElementById('lab-content')){
  const selector=document.getElementById('scenario'),status=document.getElementById('lab-status');
  const render=()=>{
    const {result,at}=setupExample(selector.value),rows=simulationSuggestions(result.state,at.getTime()+1);
    for(const r of rows){r.status='Demo only';r.currentReason='Fictional example: '+(result.bought?'signal, execution and risk checks passed. No account entry was created.':r.currentReason);}
    document.getElementById('lab-content').innerHTML=renderSuggestions(rows);
    status.textContent=result.bought?'Example outcome: qualifies under this experimental setup. No real or saved paper purchase.':'Example outcome: entry blocked. Open the checklist to see why.';
    const details=document.querySelector('.decision-evidence');if(details)details.open=true;
  };
  selector.addEventListener('change',render);
  document.getElementById('lab-theme').addEventListener('click',e=>{
    const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';
    e.target.textContent=dark?'Light mode':'Dark mode';e.target.setAttribute('aria-pressed',String(dark));
  });render();
}
