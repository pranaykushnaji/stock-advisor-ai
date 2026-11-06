import test from 'node:test';
import assert from 'node:assert/strict';
import {assessTradingSetups,setupShortlist,SETUP_TYPES} from '../research/trading-setups.js';
import {setupExitPolicy,observeSetupExit} from '../research/setup-exits.js';
import {entryMarketContext} from '../research/entry-quality.js';
import {MULTI_SETUP_CONFIG,SIM_CONFIG,RELEASE_SIM_CONFIG} from '../research/paper-policy.js';
import {emptySimulation,transitionSimulation} from '../api/_paper-simulation.js';
import {captureEntryEvidence} from '../research/entry-evidence.js';
import {compareSetupExperiments} from '../research/setup-study.js';
import {renderSuggestions,simulationSuggestions} from '../desk/desk.js';
import {setupExample} from '../desk/setup-lab.js';
import {createSimulationHandler} from '../api/_paper-simulation-handler.js';

const open=Date.parse('2026-11-06T09:15:00+05:30'),now=new Date(open+40*60000+5000);
const minutes=bars=>bars.flatMap((b,i)=>Array.from({length:5},(_,j)=>[new Date(open+i*300000+j*60000).toISOString(),...b.slice(0,4),b[4]/5]));
function fixture(type='compression-breakout'){
  const bars=type==='trend-pullback'?[
    [100,100.3,99.8,100.2,1200],[100.2,100.55,100.1,100.45,1300],
    [100.45,100.85,100.4,100.75,1400],[100.75,101.05,100.7,100.95,1500],
    [100.95,101.3,100.9,101.2,1600],[101.2,101.21,100.75,100.9,600],
    [100.9,101,100.8,100.88,500],[100.9,101.38,100.85,101.33,1800]]:[
    [100,100.2,99.6,100,1000],[100,100.2,99.65,100.01,1100],[100.01,100.2,99.7,100.02,1000],
    [100.02,100.18,99.8,100.03,900],[100.03,100.13,99.9,100.04,600],
    [100.04,100.13,99.92,100.05,650],[100.05,100.12,99.94,100.06,600],
    [100.08,100.6,100.05,100.55,2000]];
  const price=bars.at(-1)[3]+.01,member={symbol:'ABC',name:'ABC',sector:'IT',instrumentKey:'NSE_EQ|ABC',marketCapBucket:'mid'};
  const quote={...member,price,bidPrice:price-.02,askPrice:price+.02,spreadBps:4,previousClose:99,
    upperCircuit:120,lowerCircuit:80,dayHigh:102,dayLow:99,volume:10000,lastTradeAt:now.toISOString(),responseAt:now.toISOString()};
  const benchmark={instrumentKey:'NSE_INDEX|Nifty 50',price:100.08,previousClose:100,responseAt:now.toISOString()};
  const benchmarkCandles=minutes(Array.from({length:8},(_,i)=>[100+i*.01,100.02+i*.01,99.99+i*.01,100.01+i*.01,0]));
  const research={verified:true,negative:false,type:'government order',source:'verified catalyst memory',eventPublishedAt:open-3600000,summary:'Original verified event'};
  const reference={version:2,contextVersion:1,asOf:'2026-11-06',ema20:99,averageTurnoverCr:20,return5Pct:3,atr14Pct:2};
  const m={quotes:{'NSE_EQ|ABC':quote,'NSE_INDEX|Nifty 50':benchmark},candidates:[member],safetyReady:true,
    candles:{ABC:minutes(bars)},references:{ABC:reference},benchmarkCandles,researchBySymbol:{ABC:research}};
  return {bars,quote,reference,research,m};
}
function review(f,type){return assessTradingSetups({candles:f.m.candles.ABC,quote:f.quote,reference:f.reference,research:f.research,
  marketContext:entryMarketContext(f.m.benchmarkCandles,f.m.quotes['NSE_INDEX|Nifty 50'],{now}),now,
  fillPrice:f.quote.askPrice*1.0005,allowedTypes:type?[type]:undefined});}

test('compression identifies tightening ranges, rising lows and volume dry-up before expansion',()=>{
  const f=fixture(),r=review(f,'compression-breakout');assert.equal(r.selectedType,'compression-breakout',JSON.stringify(r.lanes));
  const l=r.lanes[0];assert.ok(l.trigger>0&&l.invalidation>0);assert.ok(l.checks.every(c=>c.passed));
  f.bars[6][4]=2500;f.m.candles.ABC=minutes(f.bars);
  assert.equal(review(f,'compression-breakout').selectedType,null);
});
test('pullback recovery qualifies independently of compression, not by chasing a new session high',()=>{
  const f=fixture('trend-pullback'),r=review(f,'trend-pullback');
  assert.equal(r.selectedType,'trend-pullback',JSON.stringify(r.lanes));
  assert.equal(r.lanes[0].trigger,101);assert.ok(r.lanes[0].invalidation<100.8);
  f.bars[6]=[100.9,101,99,99.2,500];f.m.candles.ABC=minutes(f.bars);
  assert.equal(review(f,'trend-pullback').selectedType,null);
});
test('catalyst continuation requires verified positive news known before the signal, never advisor voting',()=>{
  const f=fixture();assert.equal(review(f,'catalyst-continuation').selectedType,'catalyst-continuation');
  assert.equal(review(f).selectedType,'catalyst-continuation'); // fixed documented priority
  for(const change of [{verified:false},{negative:true},{eventPublishedAt:now.getTime()+1},
    {eventPublishedAt:now.getTime()-74*3600000},{eventPublishedAt:now.getTime()-1000}]){
    const bad=fixture();Object.assign(bad.research,change);
    assert.equal(review(bad,'catalyst-continuation').selectedType,null);
  }
});
test('all lanes retain recent-market, extension, invalid-data and future-candle protections',()=>{
  const f=fixture(),before=review(f);
  f.m.candles.ABC.push([new Date(now.getTime()+60000).toISOString(),1,999,-1,0,NaN]);
  assert.deepEqual(review(f),before);
  f.quote.askPrice=103;assert.equal(review(f).selectedType,null);
  const bad=fixture();bad.m.candles.ABC[0][2]=50;assert.equal(review(bad).selectedType,null);
  const weak=fixture();weak.m.quotes['NSE_INDEX|Nifty 50'].price=99;
  assert.equal(review(weak).selectedType,null);
  assert.throws(()=>review(f,'unknown'),/Invalid setup lanes/);
});
test('bounded shortlist rotates eligible research while respecting exclusions and verified-event priority',()=>{
  const ranked=Array.from({length:20},(_,i)=>({symbol:`A${i}`,discoveryScore:100-i})),at=new Date(now);
  const first=setupShortlist(ranked,{at}),second=setupShortlist(ranked,{at:new Date(at.getTime()+300000)});
  assert.equal(first.length,8);assert.equal(new Set(first.map(r=>r.symbol)).size,8);
  assert.notDeepEqual(first,second);
  const research={A19:fixture().research};
  assert.ok(setupShortlist(ranked,{at,research,pending:['not-eligible','A18']}).some(r=>r.symbol==='A19'));
  assert.ok(!setupShortlist(ranked,{at,pending:['not-eligible']}).some(r=>r.symbol==='not-eligible'));
});
test('new lanes save frozen exit profiles, one-share allocation, typed evidence and actionable details',()=>{
  const f=fixture(),r=transitionSimulation(emptySimulation(),f.m,{at:now,action:'scan',config:MULTI_SETUP_CONFIG});
  assert.equal(r.bought,'ABC',r.state.suggestions[0].reasons.join());
  const p=r.state.positions[0];assert.equal(p.shares,1);assert.equal(p.setupType,'catalyst-continuation');
  assert.equal(p.exitPolicy.mode,'setup-risk');assert.equal(p.exitPolicy.activationR,2);
  assert.equal(p.decisionEvidence.readiness.ready,true);assert.equal(p.researchCohort,'research-backed');
  assert.equal(SIM_CONFIG.setupMode,undefined); // original research comparator stays reproducible
  const html=renderSuggestions(simulationSuggestions(r.state,now.getTime()+1));
  assert.match(html,/Setup plans/);assert.match(html,/Observed trigger/);assert.match(html,/Frozen exit experiment/);
  assert.match(html,/Confirmation checklist/);assert.doesNotMatch(html,/80% confidence/);
  assert.equal(transitionSimulation(r.state,f.m,{at:now,action:'scan',config:MULTI_SETUP_CONFIG}).status,'duplicate');
});
test('no new setup overrides risk, safety, same-session duplicate or stale-price requirements',()=>{
  for(const mutate of [m=>m.safetyReady=false,m=>m.quotes['NSE_EQ|ABC'].bidPrice=null,
    m=>m.quotes['NSE_EQ|ABC'].lastTradeAt=new Date(now.getTime()-120000).toISOString(),m=>m.negativeSymbols=['ABC']]){
    const f=fixture();mutate(f.m);
    assert.equal(transitionSimulation(emptySimulation(),f.m,{at:now,action:'scan',config:MULTI_SETUP_CONFIG}).bought,null);
  }
  const f=fixture(),s=emptySimulation();s.days['2026-11-06']={buys:['ABC'],exits:[],invested:0,contribution:0};
  assert.equal(transitionSimulation(s,f.m,{at:now,action:'scan',config:MULTI_SETUP_CONFIG}).bought,null);
});
test('risk and ATR exit profiles stay frozen and never relax the initial or already armed stop',()=>{
  const risk=setupExitPolicy('trend-pullback',{mode:'setup-risk',entryPrice:100,initialStopPrice:99});
  const vol=setupExitPolicy('trend-pullback',{mode:'setup-volatility',entryPrice:100,initialStopPrice:99,atr14Pct:5});
  assert.equal(risk.trailR,1.5);assert.equal(vol.trailR,2);
  assert.throws(()=>setupExitPolicy('trend-pullback',{mode:'setup-volatility',entryPrice:100,initialStopPrice:99}),/ATR14/);
  const p={id:'p',symbol:'ABC',instrumentKey:'NSE_EQ|ABC',entryPrice:100,initialStopPrice:99,peakPrice:104,trailingStopPrice:103,
    lastObservedAt:new Date(now.getTime()-300000).toISOString(),exitPolicy:vol};
  const q={...fixture().quote,price:102,bidPrice:101.98};
  const r=observeSetupExit(p,q,{nowMs:now.getTime()});assert.equal(r.status,'exit-proposed');
  assert.equal(r.state.initialStopPrice,99);assert.ok(r.state.trailingStopPrice>=103);
  assert.deepEqual(r.state.exitPolicy,vol);assert.deepEqual(p.exitPolicy,vol);
  const stopped=observeSetupExit({...p,exitPolicy:{...vol,trailR:NaN}}, {...q,price:98,bidPrice:97.98},{nowMs:now.getTime()});
  assert.equal(stopped.status,'exit-proposed');assert.match(stopped.policyWarning,/protection retained/);
});
test('setup exit modes produce distinct outcomes, and policy corruption cannot suppress a stop',()=>{
  const p={id:'p',symbol:'ABC',ticker:'ABC',instrumentKey:'NSE_EQ|ABC',date:'2026-11-06',entryPrice:100,initialStopPrice:99,
    peakPrice:103,lastObservedAt:new Date(now.getTime()-300000).toISOString()};
  const q={...fixture().quote,price:101.7,bidPrice:101.68};
  const original=observeSetupExit(p,q,{nowMs:now.getTime()});
  const exitPolicy=setupExitPolicy('trend-pullback',{mode:'setup-risk',entryPrice:100,initialStopPrice:99});
  const profile=observeSetupExit({...p,exitPolicy},q,{nowMs:now.getTime()});
  assert.equal(original.status,'exit-proposed');assert.equal(profile.status,'hold');
  const f=fixture(),state=transitionSimulation(emptySimulation(),f.m,{at:now,action:'scan',config:MULTI_SETUP_CONFIG}).state;
  state.positions[0].exitPolicy.trailR=99;
  const later=new Date(now.getTime()+300000),low={...f.quote,price:98,bidPrice:97.98,lastTradeAt:later.toISOString(),responseAt:later.toISOString()};
  const r=transitionSimulation(state,{quotes:{[low.instrumentKey]:low}}, {at:later,action:'risk',config:MULTI_SETUP_CONFIG});
  assert.equal(r.state.positions.length,0);assert.equal(r.state.trades.length,1);assert.equal(r.status,'partial');
  assert.match(r.checked[0].warning,/original protection/);
});
test('ATR-specific experiment rejects missing ATR before funding a buy, without blocking exits',()=>{
  const f=fixture();delete f.reference.atr14Pct;
  const r=transitionSimulation(emptySimulation(),f.m,{at:now,action:'scan',config:{...MULTI_SETUP_CONFIG,exitMode:'setup-volatility'}});
  assert.equal(r.bought,null);assert.equal(r.state.contributions,0);
  assert.match(r.state.suggestions[0].reasons.join(),/atr14Pct/);
  assert.equal(r.state.suggestions[0].decisionEvidence.metrics.atr14Pct.required,true);
});
test('same point-in-time evidence drives all eight isolated setup/exit scenarios; missing history is honest',()=>{
  const f=fixture(),record={updatedAt:now.toISOString(),entryEvidence:captureEntryEvidence(f.m,now)};
  const before=structuredClone(record),report=compareSetupExperiments([record,record]);
  assert.deepEqual(record,before);assert.equal(report.variants.length,8);assert.equal(report.ordersExecuted,0);
  const multi=report.variants.find(v=>v.mode==='three-setups-risk-exits');assert.equal(multi.entries,1);
  assert.equal(multi.groups[0].setup,'catalyst-continuation');assert.equal(multi.groups[0].cohort,'research-backed');
  assert.equal(multi.groups[0].closedWinRatePct,null);
  assert.equal(compareSetupExperiments([{}]).status,'no_recorded_evidence');
  assert.equal(compareSetupExperiments([]).variants.every(v=>v.entries===0),true);
});
test('setup lab examples are explicitly synthetic and the weakening-market example cannot enter',()=>{
  for(const type of SETUP_TYPES){
    const {result}=setupExample(type);assert.equal(result.bought,'SAMPLE');
    const p=result.state.positions[0];assert.equal(p.synthetic,true);assert.equal(p.executed,false);
    assert.equal(p.setupType,type);assert.equal(p.excludeFromLiveStatistics,true);
  }
  assert.equal(setupExample('weak-market').result.bought,null);
});
test('explicitly configured handler integrates bounded research, shared setup logic and frozen exits',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test-setup-auth';
  const f=fixture();let state=emptySimulation(),historyCalls=0;state.dailyCache.ABC=f.reference;
  const handler=createSimulationHandler({config:MULTI_SETUP_CONFIG,now:()=>now,
    env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    members:f.m.candidates,registryFetchedAt:'2026-11-05T00:00:00Z',read:async()=>({data:structuredClone(state),sha:'test'}),
    write:async s=>{state=s;return true;},safety:async()=>({safetyReady:true,researchBySymbol:f.m.researchBySymbol}),
    quotes:async keys=>Object.fromEntries(keys.map(k=>[k,f.m.quotes[k]])),
    intraday:async key=>{historyCalls++;return key==='NSE_INDEX|Nifty 50'?f.m.benchmarkCandles:f.m.candles.ABC;},
    daily:async()=>{throw Error('must reuse cached daily reference');}});
  const res={setHeader(){},status(n){this.code=n;return this;},json(body){this.body=body;return this;}};
  try{
    await handler({method:'POST',query:{action:'scan'},body:{setupMode:'untrusted override ignored'},headers:{authorization:'Bearer test-setup-auth'}},res);
    assert.equal(res.code,200);assert.equal(res.body.bought,'ABC');assert.equal(historyCalls,2);
    assert.equal(res.body.setupMode,'three-setups-v1');assert.equal(res.body.ordersExecuted,0);
    assert.equal(state.positions[0].setupType,'catalyst-continuation');assert.equal(state.positions[0].exitPolicy.mode,'setup-risk');
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
test('approved release selects all three paper setups without changing execution or account safeguards',()=>{
  assert.equal(RELEASE_SIM_CONFIG,MULTI_SETUP_CONFIG);
  assert.equal(RELEASE_SIM_CONFIG.setupMode,'three-setups-v1');assert.equal(RELEASE_SIM_CONFIG.exitMode,'setup-risk');
  assert.equal(RELEASE_SIM_CONFIG.allowedSetupTypes,undefined);assert.equal(RELEASE_SIM_CONFIG.sharesPerEntry,1);
  assert.equal(RELEASE_SIM_CONFIG.modeledRiskPerTrade,100);assert.equal(RELEASE_SIM_CONFIG.maxModeledOpenRisk,500);
  const f=fixture(),s=transitionSimulation(emptySimulation(),f.m,{at:now,action:'scan',config:RELEASE_SIM_CONFIG}).state;
  const policy=structuredClone(s.positions[0].exitPolicy),initialStop=s.positions[0].initialStopPrice;
  const later=new Date(now.getTime()+300000),q={...f.quote,price:100.7,bidPrice:100.68,lastTradeAt:later.toISOString(),responseAt:later.toISOString()};
  const r=transitionSimulation(s,{quotes:{[q.instrumentKey]:q}},{at:later,action:'risk',config:{...RELEASE_SIM_CONFIG,exitMode:'setup-volatility'}});
  assert.deepEqual(r.state.positions[0].exitPolicy,policy);assert.equal(r.state.positions[0].initialStopPrice,initialStop);
});
