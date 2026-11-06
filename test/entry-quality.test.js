import test from 'node:test';
import assert from 'node:assert/strict';
import {ENTRY_QUALITY,entryMarketContext,assessPaperEntry,researchCohort} from '../research/entry-quality.js';
import {emptySimulation,transitionSimulation,dailyReference} from '../api/_paper-simulation.js';
import {createSimulationHandler} from '../api/_paper-simulation-handler.js';
import {BASELINE_SIM_CONFIG,SIM_CONFIG} from '../research/paper-policy.js';
import {captureEntryEvidence,readEntryEvidence} from '../research/entry-evidence.js';
import {replayPointInTimeEntries} from '../research/point-in-time-entry-replay.js';

const opening=Date.parse('2026-11-04T09:15:00+05:30');
const now=new Date(opening+8*300000+5000);
function minutes(bars){return bars.flatMap((b,i)=>Array.from({length:5},(_,j)=>[
  new Date(opening+i*300000+j*60000).toISOString(),...b.slice(0,4),b[4]/5]));}
function fixture(){
  const bars=Array.from({length:6},(_,i)=>[100,100.25,99.95,100+i*.02,1000]);
  bars.push([100.2,100.7,100.19,100.55,2500],[100.55,100.72,100.48,100.68,1400]);
  const index=Array.from({length:8},(_,i)=>[100+i*.01,100.02+i*.01,99.99+i*.01,100.01+i*.01,0]);
  return {bars,index,candles:minutes(bars),benchmarkCandles:minutes(index),
    quote:{symbol:'ABC',instrumentKey:'NSE_EQ|ABC',price:100.7,bidPrice:100.68,askPrice:100.72,spreadBps:4,
      upperCircuit:120,lowerCircuit:80,dayHigh:101,dayLow:99,previousClose:99,volume:10000,
      lastTradeAt:now.toISOString(),responseAt:now.toISOString()},
    benchmarkQuote:{instrumentKey:'NSE_INDEX|Nifty 50',price:100.08,previousClose:100,responseAt:now.toISOString()},
    reference:{version:2,contextVersion:1,asOf:'2026-11-04',ema20:99,averageTurnoverCr:20,return5Pct:3}};
}
function assess(f=fixture(),mode='adaptive',at=now){return assessPaperEntry({candles:f.candles,quote:f.quote,
  reference:f.reference,marketContext:entryMarketContext(f.benchmarkCandles,f.benchmarkQuote,{now:at}),now:at,mode,
  fillPrice:f.quote.askPrice*(1+SIM_CONFIG.entrySlippageBps/10000)});}
function market(f){return {quotes:{'NSE_EQ|ABC':f.quote,'NSE_INDEX|Nifty 50':f.benchmarkQuote},safetyReady:true,
  candidates:[{symbol:'ABC',name:'ABC',sector:'IT',instrumentKey:'NSE_EQ|ABC'}],
  candles:{ABC:f.candles},benchmarkCandles:f.benchmarkCandles,references:{ABC:f.reference}};}

test('confirmed entry waits a full candle; baseline alone can buy the first breakout',()=>{
  const f=fixture(),early=new Date(now.getTime()-300000);
  const q={...f.quote,price:100.55,lastTradeAt:early.toISOString(),responseAt:early.toISOString()};
  const baseline=assessPaperEntry({candles:f.candles,quote:q,now:early,mode:'baseline'});
  assert.equal(baseline.setup.status,'setup');
  const waiting=assess({...f,quote:q,benchmarkQuote:{...f.benchmarkQuote,responseAt:early.toISOString()}},'adaptive',early);
  assert.equal(waiting.status,'blocked');assert.match(waiting.reasons.join(),/waiting/);
  const confirmed=assess(f);assert.equal(confirmed.status,'qualified',confirmed.reasons.join());
  assert.equal(confirmed.setup.confirmationType,'follow-through');assert.equal(confirmed.setup.entryAt,f.quote.lastTradeAt);
  assert.equal(confirmed.setup.signalAgeMinutes,5);
});
test('retest requires a later candle touching and recovering the original level',()=>{
  const f=fixture();assert.equal(assess(f,'retest').status,'blocked');
  f.bars[7]=[100.4,100.72,100.28,100.68,1400];f.candles=minutes(f.bars);
  const r=assess(f,'retest');assert.equal(r.status,'qualified',r.reasons.join());assert.equal(r.setup.confirmationType,'retest');
  f.bars[7]=[100.4,100.72,99.9,100.68,1400];f.candles=minutes(f.bars);
  assert.equal(assess(f,'retest').status,'blocked');
});
test('market weakening blocks entries even when Nifty remains strongly positive for the day',()=>{
  const f=fixture();f.benchmarkQuote.previousClose=98;
  f.index[6]=[100.15,100.2,100.1,100.18,0];f.index[7]=[100.18,100.2,99.75,99.8,0];
  f.benchmarkCandles=minutes(f.index);f.benchmarkQuote.price=99.8;
  const context=entryMarketContext(f.benchmarkCandles,f.benchmarkQuote,{now});
  assert.ok(context.metrics.dayChangePct>1);assert.equal(context.status,'blocked');
  assert.match(context.reasons.join(),/falling sharply/);assert.equal(assess(f).status,'blocked');
});
test('mild deteriorating trend, post-candle drop, missing history and stale index all fail closed',()=>{
  const f=fixture();f.index[7]=[100.07,100.08,100,100.01,0];f.benchmarkCandles=minutes(f.index);f.benchmarkQuote.price=100.01;
  assert.match(entryMarketContext(f.benchmarkCandles,f.benchmarkQuote,{now}).reasons.join(),/trend deteriorating/);
  const good=fixture();good.benchmarkQuote.price=99.9;
  assert.match(entryMarketContext(good.benchmarkCandles,good.benchmarkQuote,{now}).reasons.join(),/after latest/);
  assert.equal(entryMarketContext(undefined,good.benchmarkQuote,{now}).status,'blocked');
  good.benchmarkQuote.responseAt=new Date(now.getTime()-120000).toISOString();
  assert.equal(entryMarketContext(good.benchmarkCandles,good.benchmarkQuote,{now}).status,'blocked');
});
test('stock must outperform recently, not merely retain a large gain since yesterday',()=>{
  const f=fixture();f.bars[7]=[100.55,100.6,100.2,100.3,1400];f.candles=minutes(f.bars);f.quote.price=100.3;
  f.quote.previousClose=95;const r=assess(f);
  assert.equal(r.status,'blocked');assert.match(r.reasons.join(),/momentum not positive/);
  const stronger=fixture();stronger.index=stronger.index.map((b,i)=>[100+i*.3,100.1+i*.3,99.9+i*.3,100+i*.3,0]);
  stronger.benchmarkCandles=minutes(stronger.index);stronger.benchmarkQuote.price=102.1;
  assert.match(assess(stronger).reasons.join(),/not outperforming Nifty over recent/);
});
test('executable ask, not last traded price, determines extension rejection',()=>{
  const f=fixture();f.quote.askPrice=101.1;
  assert.match(assess(f).reasons.join(),/ask plus slippage too far/);
});
test('multi-session exhaustion, missing baseline and range expansion are independently recorded',()=>{
  const f=fixture();f.reference.ema20=94;f.reference.return5Pct=15;
  assert.match(assess(f).reasons.join(),/extended multi-session/);
  delete f.reference.version;assert.match(assess(f).reasons.join(),/prior-session/);
  const wide=fixture();wide.bars[7]=[100.3,101.9,100.2,100.68,1400];wide.candles=minutes(wide.bars);
  assert.match(assess(wide).reasons.join(),/range abnormally expanded/);
});
test('future and incomplete confirmation candles cannot change an earlier decision',()=>{
  const f=fixture(),before=assess(f);
  const future=Array.from({length:5},(_,i)=>[new Date(opening+40*60000+i*60000).toISOString(),200,205,199,204,1e9]);
  assert.deepEqual(assess({...f,candles:[...f.candles,...future]}),before);
  f.candles.splice(-2,1);assert.equal(assess(f).status,'blocked');
  const q={...fixture().quote,lastTradeAt:new Date(now.getTime()+1000).toISOString()};
  assert.equal(assess({...fixture(),quote:q}).status,'blocked');
});
test('cohort labels require fresh verified research; an advisor headline is price-only',()=>{
  const event={verified:true,eventPublishedAt:now.getTime()-3600000};
  assert.equal(researchCohort(event,now),'research-backed');
  for(const bad of [null,{...event,verified:false},{...event,negative:true},{...event,eventPublishedAt:now.getTime()+1},
    {...event,eventPublishedAt:now.getTime()-73*3600000},{verified:true}])assert.equal(researchCohort(bad,now),'price-only');
});
test('production path saves confirmation/market/cohort evidence and preserves one-share dedup',()=>{
  const f=fixture(),m=market(f),one=transitionSimulation(emptySimulation(),m,{at:now,action:'scan'});
  assert.equal(one.bought,'ABC',one.state.suggestions[0]?.reasons.join());
  const p=one.state.positions[0];assert.equal(p.shares,1);assert.equal(p.entryAssessment.status,'qualified');
  assert.equal(p.entryMarket.status,'supportive');assert.equal(p.researchCohort,'price-only');
  assert.equal(transitionSimulation(one.state,m,{at:now,action:'scan'}).status,'duplicate');
  assert.equal(one.state.config.executionRuleVersion,'five-minute-confirmed-v4');
});
test('missing/weak Nifty history cannot prevent an existing position stop exit',()=>{
  const f=fixture(),s=transitionSimulation(emptySimulation(),market(f),{at:now,action:'scan'}).state;
  const later=new Date(now.getTime()+300000),q={...f.quote,price:98,bidPrice:97.99,lastTradeAt:later.toISOString(),responseAt:later.toISOString()};
  const r=transitionSimulation(s,{...market(f),benchmarkCandles:[],safetyReady:false,quotes:{'NSE_EQ|ABC':q}},
    {at:later,action:'scan'});
  assert.equal(r.state.positions.length,0);assert.equal(r.state.trades.length,1);
  assert.equal(r.state.trades[0].exitReason,'initial invalidation');assert.equal(r.bought,null);
});
test('daily stock movement excludes current/future days and upgrades reference version',()=>{
  const rows=Array.from({length:25},(_,i)=>[`2026-10-${String(i+1).padStart(2,'0')}`,100+i,101+i,99+i,100+i,1e6]);
  rows.push(['2026-11-04',999,999,999,999,1e9]);
  const r=dailyReference(rows,'2026-11-04');assert.equal(r.version,2);assert.equal(r.previousClose,124);
  assert.ok(Math.abs(r.return5Pct-(124/119-1)*100)<1e-9);
});
test('handler fetches Nifty candles once and a candle outage blocks entries without failing the scan',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test';
  let current=emptySimulation(),indexCalls=0;const f=fixture(),m=market(f);current.dailyCache.ABC=f.reference;
  const h=createSimulationHandler({now:()=>now,env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    members:m.candidates.map(x=>({...x,marketCapBucket:'mid'})),registryFetchedAt:'2026-11-03T00:00:00Z',
    read:async()=>({data:structuredClone(current),sha:'x'}),write:async s=>{current=s;return true;},
    safety:async()=>({safetyReady:true}),quotes:async keys=>Object.fromEntries(keys.map(k=>[k,m.quotes[k]])),
    intraday:async key=>{if(key==='NSE_INDEX|Nifty 50'){indexCalls++;throw Error('outage');}return f.candles;}});
  const res={setHeader(){},status(){return this;},json(d){this.body=d;return this;}};
  try{await h({method:'POST',query:{action:'scan'},headers:{authorization:'Bearer test'}},res);
    assert.equal(indexCalls,1);assert.equal(current.positions.length,0);assert.equal(current.discovery.entryMarket.status,'blocked');
    assert.notEqual(res.body.status,'simulation_failed');
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
test('new opening confirmation can enter at 09:35 without a 10am wall-clock delay',()=>{
  const f=fixture(),early=new Date(opening+4*300000+5000);
  f.candles=minutes([...f.bars.slice(0,2),...f.bars.slice(-2)]);
  f.benchmarkCandles=minutes(f.index.slice(0,4));
  f.quote.lastTradeAt=early.toISOString();f.quote.responseAt=early.toISOString();
  f.benchmarkQuote.responseAt=early.toISOString();f.benchmarkQuote.price=100.04;
  const r=assess(f,'adaptive',early);assert.equal(r.status,'qualified',r.reasons.join());
  assert.equal(r.setup.setupVersion,'opening-consolidation-v1');
});
test('pending signals persist briefly, expire, and remain isolated from old accounting records',()=>{
  const f=fixture(),early=new Date(now.getTime()-300000);
  f.quote.lastTradeAt=early.toISOString();f.quote.responseAt=early.toISOString();f.quote.price=100.55;
  f.benchmarkQuote.responseAt=early.toISOString();f.benchmarkQuote.price=100.07;
  const first=transitionSimulation(emptySimulation(),market(f),{at:early,action:'scan'});
  assert.equal(first.bought,null);assert.ok(first.state.pendingEntries.ABC);
  const late=new Date(early.getTime()+20*60000),m=market(f);m.candidates=[];
  const expired=transitionSimulation(first.state,m,{at:late,action:'scan'});
  assert.deepEqual(expired.state.pendingEntries,{});assert.equal(expired.state.contributions,0);
});
test('bounded point-in-time archive strips unrelated quote fields and cannot break risk if too large',()=>{
  const f=fixture(),m=market(f);m.quotes['NSE_EQ|ABC'].unrelated='not a market field';
  const evidence=captureEntryEvidence(m,now),decoded=readEntryEvidence(evidence);
  assert.equal(decoded.quotes['NSE_EQ|ABC'].unrelated,undefined);
  assert.deepEqual(decoded.candles.ABC,f.candles);assert.equal(evidence.status,'recorded');
  assert.equal(captureEntryEvidence(m,now,{maxCharacters:10}).status,'omitted');
  assert.equal(readEntryEvidence({version:1,status:'recorded',encoding:'json',payload:'bad'}),null);
});
test('exact-logic comparison reuses production transition and excludes ALL hypothetical rows from account stats',()=>{
  const f=fixture(),state=transitionSimulation(emptySimulation(),market(f),{at:now,action:'scan'}).state;
  const before=structuredClone(state),report=replayPointInTimeEntries([state,state]);
  assert.deepEqual(state,before);assert.equal(report.status,'evidence_available');assert.equal(report.ordersExecuted,0);
  const adaptive=report.variants.find(v=>v.mode==='adaptive');assert.equal(adaptive.frames,1);
  assert.equal(adaptive.state.positions.length,1);assert.equal(adaptive.state.positions[0].entryPrice,state.positions[0].entryPrice);
  assert.equal(adaptive.state.positions[0].excludeFromLiveStatistics,true);
  assert.equal(replayPointInTimeEntries([{}, {lastCheck:{action:'scan'}}]).variants[0].frames,0);
  assert.equal(replayPointInTimeEntries([]).status,'no_recorded_evidence');
});
test('handler confirms an entry with real index history, caches daily context and exposes execution version',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test';let current=emptySimulation(),calls=0,dailyCalls=0;
  const f=fixture(),m=market(f);current.dailyCache.ABC=f.reference;
  const h=createSimulationHandler({now:()=>now,env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    members:m.candidates.map(c=>({...c,marketCapBucket:'mid'})),registryFetchedAt:'2026-11-03T00:00:00Z',
    read:async()=>({data:structuredClone(current),sha:'x'}),write:async s=>{current=s;return true;},
    safety:async()=>({safetyReady:true}),quotes:async keys=>Object.fromEntries(keys.map(k=>[k,m.quotes[k]])),
    intraday:async key=>{if(key==='NSE_INDEX|Nifty 50'){calls++;return f.benchmarkCandles;}return f.candles;},
    daily:async()=>{dailyCalls++;return [];}});
  const res={setHeader(){},status(){return this;},json(d){this.body=d;return this;}};
  try{await h({method:'POST',query:{action:'scan'},headers:{authorization:'Bearer test'}},res);
    assert.equal(res.body.bought,'ABC');assert.equal(res.body.executionRuleVersion,'five-minute-confirmed-v4');
    assert.equal(current.positions.length,1);assert.equal(current.positions[0].shares,1);
    assert.equal(calls,1);assert.equal(dailyCalls,0);assert.equal(current.entryEvidence.status,'recorded');
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
