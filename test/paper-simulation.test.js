import test from 'node:test';
import assert from 'node:assert/strict';
import {emptySimulation,validateSimulation,dailyReference,transitionSimulation,rankSimulationUniverse,SIM_CONFIG} from '../api/_paper-simulation.js';
import {createSimulationHandler} from '../api/_paper-simulation-handler.js';

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
  assert.ok(Number.isInteger(p.shares));assert.ok(p.investedAmount<=5000);assert.ok(p.modeledInitialRisk<=100);
  assert.equal(p.addedAt,at.toISOString());assert.equal(p.expectedEdge,null);
  assert.equal(r.state.cash,Math.round((10000-p.investedAmount-p.entryCost)*100)/100);
  assert.equal(r.state.days['2026-11-04'].buys.length,1);
});
test('daily investment is aggregate, costs included, never recycled by an exit',()=>{
  let s=emptySimulation();const all=[c('A','IT'),c('B','Pharma'),c('C','Capital'),c('D','Retail')];
  for(let i=0;i<4;i++){const at=new Date(start+i*900000);s=transitionSimulation(s,market(at,all),{at,action:'scan'}).state;}
  const day=s.days['2026-11-04'];assert.ok(day.invested<=10000);assert.equal(day.buys.length,3);assert.equal(s.contributions,10000);
  assert.ok(s.positions.every(p=>p.modeledInitialRisk<=100));
  const at=new Date(start+4*900000),m=market(at,all);
  for(const key of Object.keys(m.quotes))if(key!=='NSE_INDEX|Nifty 50')m.quotes[key]={...m.quotes[key],price:95,bidPrice:94.95,askPrice:95.05};
  const sold=transitionSimulation(s,m,{at,action:'risk'});assert.equal(sold.state.positions.length,0);
  assert.equal(sold.state.days['2026-11-04'].invested,day.invested);
  const againAt=new Date(start+5*900000),again=transitionSimulation(sold.state,market(againAt,all),{at:againAt,action:'scan'});
  assert.equal(again.state.positions.length,0);assert.equal(again.state.trades.length,3);
});
test('duplicate ticks and stale quotes never duplicate deposits, entries or exit records',()=>{
  const at=new Date(start),m=market(at),one=transitionSimulation(emptySimulation(),m,{at,action:'scan'});
  const twice=transitionSimulation(one.state,m,{at,action:'scan'});assert.equal(twice.status,'duplicate');assert.equal(twice.state.positions.length,1);
  const later=new Date(start+5*60000),stale=transitionSimulation(one.state,m,{at:later,action:'risk'});
  assert.equal(stale.status,'partial');assert.equal(stale.state.positions.length,1);assert.equal(stale.state.trades.length,0);
});
test('new day adds exactly one contribution, even across concurrent action kinds',()=>{
  const at=new Date(start),s=transitionSimulation(emptySimulation(),market(at),{at,action:'risk'}).state;
  const r=transitionSimulation(s,market(at),{at,action:'scan'});assert.equal(r.state.contributions,10000);
  const tomorrow=new Date(start+86400000),r2=transitionSimulation(r.state,{quotes:{}},{at:tomorrow,action:'risk'});
  assert.equal(r2.state.contributions,20000);
});
test('new risk evidence can exit at an already-observed fresh quote without reversing price state',()=>{
  const at=new Date(start),m=market(at),s=transitionSimulation(emptySimulation(),m,{at,action:'scan'}).state;
  const r=transitionSimulation(s,{...m,negativeSymbols:['ABC']},{at:new Date(start+1000),action:'risk'});
  assert.equal(r.state.positions.length,0);assert.equal(r.state.trades.length,1);
});
test('missing budgets do not matter: fixed experiment caps are explicit and safety context fails closed',()=>{
  const at=new Date(start),m=market(at);m.safetyReady=false;
  const r=transitionSimulation(emptySimulation(),m,{at,action:'scan'});assert.equal(r.bought,null);
  assert.match(r.state.suggestions[0].reasons.join(),/safety context/);
  assert.throws(()=>validateSimulation({...emptySimulation(),cash:NaN}),/Invalid/);
  assert.equal(SIM_CONFIG.dailyInvestment,10000);
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
  const h=createSimulationHandler({env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},now:()=>at,members:[member],
    read:async()=>({data:structuredClone(current),sha:String(writes)}),write:async(state)=>{writes++;if(writes===1){current=state;return false;}current=state;return true;},
    quotes:async keys=>Object.fromEntries(keys.map(k=>[k,m.quotes[k]])),intraday:async()=>candles(at),daily:async()=>[],safety:async()=>({safetyReady:true,negativeSymbols:[],surveillance:[]})});
  current.dailyCache.ABC={asOf:'2026-11-04',ema20:99,averageTurnoverCr:20};
  const res={status(){return this;},json(d){this.body=d;return this;},setHeader(){}};
  try{await h({method:'POST',query:{action:'scan'},headers:{authorization:'Bearer test'}},res);
    assert.equal(current.positions.length,1);assert.equal(current.days['2026-11-04'].buys.length,1);assert.equal(current.contributions,10000);
    assert.equal(res.body.status,'duplicate');
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
