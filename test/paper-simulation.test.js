import test from 'node:test';
import assert from 'node:assert/strict';
import {emptySimulation,validateSimulation,dailyReference,transitionSimulation as executeTransition,rankSimulationUniverse,SIM_CONFIG,LEGACY_SIM_CONFIG,paperEntryAllocation} from '../api/_paper-simulation.js';
import {BASELINE_SIM_CONFIG} from '../research/paper-policy.js';
import {createSimulationHandler} from '../api/_paper-simulation-handler.js';
import {savedResearchContext,verifiedResearchEvent} from '../api/_paper-research-context.js';
import {liveSimulationEntry} from '../api/_entry-research.js';
// These are ledger/funding regression fixtures for the original entry signal.
// The production confirmation path is tested separately in entry-quality.test.js.
const transitionSimulation=(s,m,options)=>executeTransition(s,m,{config:BASELINE_SIM_CONFIG,...options});

const start=Date.parse('2026-11-04T04:30:05Z');
const c=(symbol='ABC',sector='IT')=>({symbol,name:symbol,sector,marketCapBucket:'mid',instrumentKey:`NSE_EQ|${symbol}`});
function quote(member,at,price=101){return {symbol:member.symbol,instrumentKey:member.instrumentKey,price,
  bidPrice:price-0.05,askPrice:price+0.05,spreadBps:10,upperCircuit:120,lowerCircuit:80,
  dayHigh:102,dayLow:98,previousClose:100,volume:1e7,lastTradeAt:at.toISOString(),responseAt:at.toISOString()};}
function candles(at){const boundary=Math.floor(at.getTime()/300000)*300000;return Array.from({length:35},(_,i)=>{
  const ms=boundary-35*60000+i*60000,isBreak=i>=30;
  return [new Date(ms).toISOString(),isBreak?100.3:100,isBreak?101.2:100.2,isBreak?100.3:99.5,isBreak?101:100,isBreak?300:100];
});}
function market(at,members=[c()]){
  const quotes=Object.fromEntries(members.map(m=>[m.instrumentKey,quote(m,at)]));
  quotes['NSE_INDEX|Nifty 50']={...quote({symbol:'Nifty 50',instrumentKey:'NSE_INDEX|Nifty 50'},at),price:100.2};
  return {quotes,safetyReady:true,candidates:members,negativeSymbols:[],candles:Object.fromEntries(members.map(m=>[m.symbol,candles(at)])),
    references:Object.fromEntries(members.map(m=>[m.symbol,{asOf:'2026-11-04',ema20:99,averageTurnoverCr:20}]))};
}
test('experimental simulation opens whole shares with actual quote timestamps and cash accounting',()=>{
  const at=new Date(start),r=transitionSimulation(emptySimulation(),market(at),{at,action:'scan'});
  assert.equal(r.bought,'ABC');const p=r.state.positions[0];
  assert.equal(p.shares,1);assert.ok(p.modeledInitialRisk<=100);
  assert.equal(p.addedAt,at.toISOString());assert.equal(p.expectedEdge,null);
  assert.equal(r.state.cash,0);assert.equal(r.state.contributions,Math.round((p.investedAmount+p.entryCost)*100)/100);
  assert.equal(r.state.days['2026-11-04'].buys.length,1);
  const invalid=structuredClone(r.state);invalid.positions[0].shares=5;
  assert.throws(()=>validateSimulation(invalid),/Invalid paper position/);
});
test('legacy replay policy keeps its original aggregate daily budget and count caps',()=>{
  let s=emptySimulation();const all=[c('A','IT'),c('B','Pharma'),c('C','Capital'),c('D','Retail')];
  for(let i=0;i<4;i++){const at=new Date(start+i*900000);s=transitionSimulation(s,market(at,all),{at,action:'scan',config:LEGACY_SIM_CONFIG}).state;}
  const day=s.days['2026-11-04'];assert.ok(day.invested<=10000);assert.equal(day.buys.length,3);assert.equal(s.contributions,10000);
  assert.ok(s.positions.every(p=>p.modeledInitialRisk<=100));
  const at=new Date(start+4*900000),m=market(at,all);
  for(const key of Object.keys(m.quotes))if(key!=='NSE_INDEX|Nifty 50')m.quotes[key]={...m.quotes[key],price:95,bidPrice:94.95,askPrice:95.05};
  const sold=transitionSimulation(s,m,{at,action:'risk',config:LEGACY_SIM_CONFIG});assert.equal(sold.state.positions.length,0);
  assert.equal(sold.state.days['2026-11-04'].invested,day.invested);
  const againAt=new Date(start+5*900000),again=transitionSimulation(sold.state,market(againAt,all),{at:againAt,action:'scan',config:LEGACY_SIM_CONFIG});
  assert.equal(again.state.positions.length,0);assert.equal(again.state.trades.length,3);
});
test('duplicate ticks and stale quotes never duplicate deposits, entries or exit records',()=>{
  const at=new Date(start),m=market(at),one=transitionSimulation(emptySimulation(),m,{at,action:'scan'});
  const twice=transitionSimulation(one.state,m,{at,action:'scan'});assert.equal(twice.status,'duplicate');assert.equal(twice.state.positions.length,1);
  const later=new Date(start+5*60000),stale=transitionSimulation(one.state,m,{at:later,action:'risk'});
  assert.equal(stale.status,'partial');assert.equal(stale.state.positions.length,1);assert.equal(stale.state.trades.length,0);
  assert.equal(one.state.scanHistory.scans.length,1);assert.equal(twice.state.scanHistory.scans.length,1);
  assert.equal(one.state.scanHistory.candidates.ABC.firstPrice,101);
});
test('days without buys add no fictional capital; capital is contributed once per accepted entry',()=>{
  const at=new Date(start),s=transitionSimulation(emptySimulation(),market(at),{at,action:'risk'}).state;
  assert.equal(s.contributions,0);
  const r=transitionSimulation(s,market(at),{at,action:'scan'});const funded=r.state.contributions;assert.ok(funded>0&&funded<200);
  const tomorrow=new Date(start+86400000),r2=transitionSimulation(r.state,{quotes:{}},{at:tomorrow,action:'risk'});
  assert.equal(r2.state.contributions,funded);assert.equal(r2.state.days['2026-11-05'].contribution,0);
});
test('new risk evidence can exit at an already-observed fresh quote without reversing price state',()=>{
  const at=new Date(start),m=market(at),s=transitionSimulation(emptySimulation(),m,{at,action:'scan'}).state;
  const r=transitionSimulation(s,{...m,negativeSymbols:['ABC']},{at:new Date(start+1000),action:'risk'});
  assert.equal(r.state.positions.length,0);assert.equal(r.state.trades.length,1);
});
test('no rupee/count caps or sector ban, but safety context and modeled risk remain mandatory',()=>{
  const at=new Date(start),m=market(at);m.safetyReady=false;
  const r=transitionSimulation(emptySimulation(),m,{at,action:'scan'});assert.equal(r.bought,null);
  assert.match(r.state.suggestions[0].reasons.join(),/safety context/);
  assert.throws(()=>validateSimulation({...emptySimulation(),cash:NaN}),/Invalid/);
  assert.equal(SIM_CONFIG.dailyInvestment,null);assert.equal(SIM_CONFIG.maxBuysPerDay,null);assert.equal(SIM_CONFIG.maxOpenPositions,null);
  assert.equal(SIM_CONFIG.maxPositionInvestment,null);assert.equal(SIM_CONFIG.sharesPerEntry,1);assert.equal(SIM_CONFIG.sectorLimit,false);
  assert.equal(SIM_CONFIG.modeledRiskPerTrade,100);assert.equal(SIM_CONFIG.maxModeledOpenRisk,500);
});
test('daily history excludes signal-day/future bars and requires complete usable baseline',()=>{
  const rows=Array.from({length:22},(_,i)=>[`2026-10-${String(i+1).padStart(2,'0')}T00:00:00Z`,100,101,99,100,2e6]);
  rows.push(['2026-11-04T00:00:00Z',1,1,1,1e6,1e9]);
  const r=dailyReference(rows,'2026-11-04');assert.equal(r.averageTurnoverCr,20);assert.equal(r.ema20,100);
  assert.equal(dailyReference(rows.slice(0,3),'2026-11-04'),null);
});
test('broad discovery does not treat stale prices, spread or circuit data as optional',()=>{
  const at=new Date(start),member=c(),q=quote(member,at);
  assert.equal(rankSimulationUniverse([member],{[member.instrumentKey]:q},{at}).ranked.length,1);
  for(const bad of [{...q,spreadBps:null},{...q,upperCircuit:101},{...q,symbol:'WRONG'}]){
    assert.equal(rankSimulationUniverse([member],{[member.instrumentKey]:bad},{at}).ranked.length,0);
  }
});
test('after-hours handler never funds, researches or writes a simulated trade, even with force',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test';let writes=0,reads=0;
  const h=createSimulationHandler({env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    now:()=>new Date('2026-11-04T00:00:00Z'),read:async()=>{reads++;return {data:emptySimulation(),sha:'x'};},write:async()=>{writes++;return true;}});
  const res={statusCode:0,status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;},setHeader(){}};
  try{await h({method:'POST',query:{action:'scan',force:'true'},headers:{authorization:'Bearer test'}},res);
    assert.equal(res.body.status,'skipped');assert.equal(writes,0);assert.equal(reads,1);
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
test('simulation handler retries CAS against fresh state without double-counting a buy',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test';let current=emptySimulation(),writes=0;
  const at=new Date(start),member=c(),m=market(at,[member]);
  const h=createSimulationHandler({config:BASELINE_SIM_CONFIG,env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},now:()=>at,members:[member],registryFetchedAt:'2026-11-03T00:00:00Z',
    read:async()=>({data:structuredClone(current),sha:String(writes)}),write:async(state)=>{writes++;if(writes===1){current=state;return false;}current=state;return true;},
    quotes:async keys=>Object.fromEntries(keys.map(k=>[k,m.quotes[k]])),intraday:async()=>candles(at),daily:async()=>[],safety:async()=>({safetyReady:true,negativeSymbols:[],surveillance:[]})});
  current.dailyCache.ABC={asOf:'2026-11-04',ema20:99,averageTurnoverCr:20};
  const res={status(){return this;},json(d){this.body=d;return this;},setHeader(){}};
  try{await h({method:'POST',query:{action:'scan'},headers:{authorization:'Bearer test'}},res);
    assert.equal(current.positions.length,1);assert.equal(current.days['2026-11-04'].buys.length,1);
    assert.equal(current.contributions,current.positions[0].investedAmount+current.positions[0].entryCost);
    assert.equal(res.body.status,'duplicate');
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});

test('opening entries mature from completed evidence, not a fixed 10am threshold',()=>{
  for(const time of ['09:15:05','09:20:05','09:25:05']){
    const at=new Date(`2026-11-04T${time}+05:30`);
    assert.notEqual(liveSimulationEntry(candles(at),quote(c(),at),{now:at}).status,'setup');
  }
  const at=new Date('2026-11-04T09:30:05+05:30');
  const r=transitionSimulation(emptySimulation(),market(at),{at,action:'scan'});
  assert.equal(r.bought,'ABC');assert.equal(r.state.positions[0].setup.setupVersion,'opening-consolidation-v1');
  assert.equal(r.state.positions[0].addedAt,at.toISOString());
  const minutes=candles(at);minutes.splice(21,1);
  assert.notEqual(liveSimulationEntry(minutes,quote(c(),at),{now:at}).status,'setup');
  const beforeSignal=quote(c(),at);beforeSignal.lastTradeAt='2026-11-04T03:59:59Z';
  assert.notEqual(liveSimulationEntry(candles(at),beforeSignal,{now:at}).status,'setup');
});
test('short opening history requires stronger volume and does not chase a gap',()=>{
  const at=new Date('2026-11-04T09:30:05+05:30'),rows=candles(at);
  for(const row of rows.slice(-5))row[5]=190;
  assert.notEqual(liveSimulationEntry(rows,quote(c(),at),{now:at}).status,'setup');
  assert.notEqual(liveSimulationEntry(candles(at),quote(c(),at,102),{now:at}).status,'setup');
});
test('premarket suggestions are persisted without funding, a price, or a fabricated pick',()=>{
  const at=new Date('2026-11-04T08:10:05+05:30'),m={candidates:[c()],researchBySymbol:{ABC:{summary:'Morning watch',verified:false}}};
  const r=transitionSimulation(emptySimulation(),m,{at,action:'research'});
  assert.equal(r.state.cash,0);assert.equal(r.state.contributions,0);assert.deepEqual(r.state.days,{});
  assert.equal(r.state.positions.length,0);assert.equal(r.state.suggestions[0].price,null);
  assert.match(r.state.suggestions[0].reasons[0],/premarket research only/);
  assert.equal(transitionSimulation(r.state,m,{at,action:'research'}).status,'duplicate');
});
test('premarket handler uses saved research without querying live executable prices or funding',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test';
  const at=new Date('2026-11-04T08:10:05+05:30');let current=emptySimulation();
  const h=createSimulationHandler({env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    now:()=>at,members:[c()],read:async()=>({data:structuredClone(current),sha:'x'}),write:async s=>{current=s;return true;},
    quotes:async()=>{throw Error('No premarket quote call allowed');},
    safety:async()=>({safetyReady:true,researchBySymbol:{ABC:{source:'morning research',verified:false,summary:'Watch'}}})});
  const res={setHeader(){},status(){return this;},json(body){this.body=body;return this;}};
  try{await h({method:'POST',query:{action:'research'},headers:{authorization:'Bearer test'}},res);
    assert.equal(res.body.status,'researched');assert.equal(current.suggestions.length,1);
    assert.equal(current.contributions,0);assert.equal(current.positions.length,0);
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
test('a stale universe pauses entries without pausing five-minute stop protection',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test';
  const entryAt=new Date(start);let current=transitionSimulation(emptySimulation(),market(entryAt),{at:entryAt,action:'scan'}).state;
  const at=new Date(start+300000),member=c();
  const h=createSimulationHandler({env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    now:()=>at,members:[member],registryFetchedAt:'2026-10-01T00:00:00Z',
    read:async()=>({data:structuredClone(current),sha:'x'}),write:async s=>{current=s;return true;},
    quotes:async keys=>{assert.deepEqual(keys,[member.instrumentKey]);return {[member.instrumentKey]:quote(member,at,95)};},
    safety:async()=>({safetyReady:true})});
  const res={setHeader(){},status(){return this;},json(body){this.body=body;return this;}};
  try{await h({method:'POST',query:{action:'scan'},headers:{authorization:'Bearer test'}},res);
    assert.equal(res.body.entryPause,'registry_stale');assert.equal(current.positions.length,0);assert.equal(current.trades.length,1);
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
test('read-only health reports the new uncapped one-share policy without changing the ledger',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test';let writes=0;
  const at=new Date(start),m=market(at),initial=emptySimulation();
  const h=createSimulationHandler({env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    now:()=>at,members:[c()],read:async()=>({data:structuredClone(initial),sha:'x'}),write:async()=>{writes++;return true;},
    quotes:async()=>m.quotes});
  const res={setHeader(){},status(){return this;},json(d){this.body=d;return this;}};
  try{await h({method:'POST',body:{mode:'health'},headers:{authorization:'Bearer test'}},res);
    assert.equal(res.body.status,'ready');assert.equal(res.body.dailyInvestment,null);assert.equal(res.body.sharesPerEntry,1);
    assert.equal(res.body.maxBuysPerDay,null);assert.equal(res.body.maxOpenPositions,null);assert.equal(res.body.sectorLimit,false);
    assert.equal(res.body.ordersExecuted,0);assert.equal(writes,0);
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
test('saved research requires original dated independent evidence; stale advisor news never gets a verified bonus',()=>{
  const at=new Date(start),event={type:'government order',summary:'Official order',verification:'VERIFIED',evidenceVersion:2,
    hasCatalyst:true,eventPublishedAt:start-3600000,evidence:[{title:'Official order',publisher:'nse-filing'}]};
  assert.equal(verifiedResearchEvent(event,start),true);
  assert.equal(verifiedResearchEvent({...event,eventPublishedAt:start-73*3600000},start),false);
  assert.equal(verifiedResearchEvent({...event,eventPublishedAt:start+1},start),false);
  assert.equal(verifiedResearchEvent({...event,evidence:[{title:'Same headline',url:'https://a.test/1'},
    {title:'Same headline',url:'https://b.test/2'}]},start),false);
  const r=savedResearchContext({watchlist:{date:'2026-11-04',builtAt:at.toISOString(),watch:[{ticker:'ABC',catalyst:event}]},
    intel:{generatedAt:'2026-07-13T00:00:00Z',items:[{ticker:'XYZ'}]}},at,[c(),c('XYZ')]);
  assert.equal(r.researchBySymbol.ABC.verified,true);assert.equal(r.researchBySymbol.XYZ,undefined);
  const base=rankSimulationUniverse([c()],market(at).quotes,{at}).ranked[0].discoveryScore;
  const bonus=rankSimulationUniverse([c()],market(at).quotes,{at,...r}).ranked[0].discoveryScore;
  assert.ok(bonus>base);
});
test('news can prioritize a suggestion but never bypass missing breakout confirmation',()=>{
  const at=new Date(start),m=market(at);m.researchBySymbol={ABC:{verified:true,summary:'Official order'}};m.candles.ABC=[];
  const r=transitionSimulation(emptySimulation(),m,{at,action:'scan'});
  assert.equal(r.bought,null);assert.equal(r.state.suggestions[0].research.verified,true);
});

test('six same-sector stocks can open one share each and deploy over ₹10,000 without count/sector caps',()=>{
  let s=emptySimulation();const members=Array.from({length:6},(_,i)=>c(`S${i}`,'Financial Services'));
  for(let i=0;i<6;i++){
    const at=new Date(start+i*300000),m=market(at,members);
    for(const member of members){
      const q=m.quotes[member.instrumentKey];
      for(const field of ['price','bidPrice','askPrice','upperCircuit','lowerCircuit','dayHigh','dayLow','previousClose'])q[field]*=30;
      for(const bar of m.candles[member.symbol])for(let j=1;j<=4;j++)bar[j]*=30;
      m.references[member.symbol].ema20*=30;
    }
    const result=transitionSimulation(s,m,{at,action:'scan'});assert.ok(result.bought);s=result.state;
  }
  assert.equal(s.positions.length,6);assert.equal(s.days['2026-11-04'].buys.length,6);
  assert.ok(s.positions.every(p=>p.shares===1));assert.ok(s.days['2026-11-04'].invested>10000);
  assert.ok(s.positions.reduce((sum,p)=>sum+p.modeledInitialRisk,0)<=500);
  assert.equal(s.cash,0);assert.equal(s.contributions,s.days['2026-11-04'].invested);
});
test('uncapped notional funding cannot bypass one-share risk limits and uses existing cash before top-ups',()=>{
  const args={fill:10000,stop:9950,positions:[],cash:0,day:{invested:20000}};
  const high=paperEntryAllocation(args);assert.equal(high.shares,1);assert.equal(high.invested,10000);assert.equal(high.contribution,10015);
  assert.equal(paperEntryAllocation({...args,cash:20000}).contribution,0);
  assert.equal(paperEntryAllocation({...args,cash:10000}).contribution,15);
  assert.equal(paperEntryAllocation({...args,fill:20000,stop:19900}).shares,0);
  assert.equal(paperEntryAllocation({...args,positions:[{modeledInitialRisk:499}]}).shares,0);
});
test('legacy positions/history retain original quantity and cost basis while new policy versions migrate safely',()=>{
  const at=new Date(start),old=transitionSimulation(emptySimulation(),market(at),{at,action:'scan',config:LEGACY_SIM_CONFIG}).state;
  const before=structuredClone(old.positions),days=structuredClone(old.days),cash=old.cash;
  assert.ok(before[0].shares>1);
  const next=transitionSimulation(old,{quotes:{}},{at:new Date(start+86400000),action:'risk'}).state;
  assert.equal(next.strategyVersion,SIM_CONFIG.version);assert.deepEqual(next.positions,before);assert.equal(next.cash,cash);
  assert.deepEqual(next.days['2026-11-04'],days['2026-11-04']);assert.equal(next.days['2026-11-05'].contribution,0);
  assert.equal(next.contributions,old.contributions);
});
test('one share never becomes repeated buys and funded capital reconciles after an exit',()=>{
  const at=new Date(start),first=transitionSimulation(emptySimulation(),market(at),{at,action:'scan'}).state;
  const againAt=new Date(start+300000),again=transitionSimulation(first,market(againAt),{at:againAt,action:'scan'}).state;
  assert.equal(again.positions.length,1);assert.equal(again.positions[0].shares,1);assert.equal(again.contributions,first.contributions);
  const exitAt=new Date(start+600000),m=market(exitAt);m.quotes[c().instrumentKey]=quote(c(),exitAt,95);
  const sold=transitionSimulation(again,m,{at:exitAt,action:'scan'}).state;
  assert.equal(sold.trades.length,1);assert.equal(sold.positions.length,0);
  assert.equal(Math.round((sold.cash-sold.contributions)*100)/100,sold.trades[0].realizedNetPnl);
  const later=new Date(start+900000),retry=transitionSimulation(sold,market(later),{at:later,action:'scan'}).state;
  assert.equal(retry.positions.length,0);assert.equal(retry.trades.length,1);assert.equal(retry.days['2026-11-04'].buys.length,1);
  const nextDay=new Date(start+86400000),nextMarket=market(nextDay);
  nextMarket.references.ABC.asOf='2026-11-05';
  const reentry=transitionSimulation(retry,nextMarket,{at:nextDay,action:'scan'}).state;
  assert.equal(reentry.positions.length,1);assert.equal(reentry.positions[0].shares,1);
  assert.notEqual(reentry.positions[0].id,reentry.trades[0].id);
});
test('handler evaluates a pre-10am non-quarter-hour scan and preserves risk exits if safety reads fail',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='test';
  let at=new Date('2026-11-04T09:35:05+05:30'),current=emptySimulation(),m=market(at),failSafety=false;
  current.dailyCache.ABC={asOf:'2026-11-04',ema20:99,averageTurnoverCr:20};
  const h=createSimulationHandler({config:BASELINE_SIM_CONFIG,env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    now:()=>at,members:[c()],registryFetchedAt:'2026-11-03T00:00:00Z',read:async()=>({data:structuredClone(current),sha:'x'}),
    write:async state=>{current=state;return true;},quotes:async keys=>Object.fromEntries(keys.map(k=>[k,m.quotes[k]])),
    intraday:async()=>candles(at),daily:async()=>[],safety:async()=>{if(failSafety)throw Error('outage');return {safetyReady:true};}});
  const req={method:'POST',query:{action:'scan'},headers:{authorization:'Bearer test'}};
  const response=()=>({setHeader(){},status(){return this;},json(d){this.body=d;return this;}});
  try{
    const r=response();await h(req,r);assert.equal(current.positions.length,1);assert.equal(r.body.bought,'ABC');
    at=new Date('2026-11-04T09:40:05+05:30');m=market(at);failSafety=true;
    m.quotes[c().instrumentKey]=quote(c(),at,95);
    await h(req,response());assert.equal(current.positions.length,0);assert.equal(current.trades.length,1);
    assert.equal(current.trades[0].exitAt,at.toISOString());
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
