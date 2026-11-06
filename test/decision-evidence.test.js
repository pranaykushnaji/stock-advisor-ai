import test from 'node:test';
import assert from 'node:assert/strict';
import {candleIntegrity} from '../research/candle-integrity.js';
import {decisionEvidence} from '../research/decision-evidence.js';
import {recoverDecisionEvidence} from '../research/decision-audit.js';
import {renderDecisionDetails} from '../desk/decision-details.js';
import {simulationSuggestions,renderSuggestions,escapeHTML,money,dateTime,renderPositions,summarizeLedger} from '../desk/desk.js';
import {emptySimulation,transitionSimulation,dailyReference} from '../api/_paper-simulation.js';
import {BASELINE_SIM_CONFIG} from '../research/paper-policy.js';
const at=new Date('2026-11-04T10:00:05+05:30'),ms=at.getTime(),boundary=Math.floor(ms/300000)*300000;
function input(){
  const quote={symbol:'ABC',instrumentKey:'NSE_EQ|ABC',price:101,bidPrice:100.95,askPrice:101.05,spreadBps:10,
    previousClose:100,lastTradeAt:at.toISOString(),responseAt:at.toISOString(),upperCircuit:120,lowerCircuit:80};
  const reference={asOf:'2026-11-04',ema20:99,averageTurnoverCr:20};
  const setup={status:'setup',supportLevel:99.5,breakoutLevel:100.2,vwap:100.1,volumeRatio:3,signalAt:new Date(boundary).toISOString()};
  const benchmark={instrumentKey:'NSE_INDEX|Nifty 50',price:100.2,previousClose:100,responseAt:at.toISOString()};
  return {quote,reference,setup,benchmark,at,safetyReady:true};
}
function market(symbols=['ABC']){
  const d=input(),candles=Array.from({length:35},(_,i)=>[new Date(boundary-35*60000+i*60000).toISOString(),
    i>=30?100.3:100,i>=30?101.2:100.2,i>=30?100.3:99.5,i>=30?101:100,i>=30?300:100]);
  return {quotes:{...Object.fromEntries(symbols.map(s=>[`NSE_EQ|${s}`,{...d.quote,symbol:s,instrumentKey:`NSE_EQ|${s}`}])),'NSE_INDEX|Nifty 50':d.benchmark},
    candidates:symbols.map(s=>({symbol:s,instrumentKey:`NSE_EQ|${s}`,sector:'IT'})),safetyReady:true,
    candles:Object.fromEntries(symbols.map(s=>[s,candles])),references:Object.fromEntries(symbols.map(s=>[s,d.reference]))};
}
const f={e:escapeHTML,money,decimal:n=>String(n),percent:n=>`${n}%`,dateTime};
test('required measurements have original sources, units and timestamps; optional indicators do not fake readiness',()=>{
  const d=decisionEvidence(input());assert.equal(d.readiness.ready,true);
  assert.equal(d.metrics.initialStop.value,99.5*.999);assert.equal(d.metrics.breakoutVolumeRatio.unit,'×');
  assert.match(d.metrics.vwap.source,/approximation/);assert.equal(d.metrics.rsi14.status,'missing');
  assert.equal(d.metrics.rsi14.required,false);assert.equal(d.metrics.ema20.source,'Upstox prior daily closes');
  assert.ok(d.notUsed.some(s=>s.includes('probability')));
});
test('missing mandatory baseline or quote timestamps prevent recording a new buy',()=>{
  for(const mutate of [m=>delete m.references.ABC.ema20,m=>delete m.references.ABC.averageTurnoverCr,
    m=>delete m.quotes['NSE_EQ|ABC'].bidPrice,m=>delete m.quotes['NSE_EQ|ABC'].lastTradeAt,
    m=>delete m.quotes['NSE_INDEX|Nifty 50'].responseAt]){
    const m=market();mutate(m);
    const r=transitionSimulation(emptySimulation(),m,{at,action:'scan',config:BASELINE_SIM_CONFIG});
    assert.equal(r.bought,null);assert.equal(r.state.positions.length,0);assert.equal(r.state.contributions,0);
    assert.match(r.state.suggestions[0].reasons.join(),/incomplete|stale|unavailable|missing|EMA|baseline/);
  }
});
test('zero returns and false checks remain explicit values, never silently converted to missing',()=>{
  const i=input();i.benchmark.price=100;i.safetyReady=false;const d=decisionEvidence(i);
  assert.equal(d.metrics.niftyDayReturnPct.value,0);assert.equal(d.metrics.niftyDayReturnPct.status,'available');
  assert.equal(d.metrics.safetyReady.value,false);assert.equal(d.metrics.safetyReady.status,'available');
  assert.equal(d.readiness.ready,true); // completeness is not strategy qualification
  const m=market();m.safetyReady=false;
  assert.equal(transitionSimulation(emptySimulation(),m,{at,action:'scan',config:BASELINE_SIM_CONFIG}).bought,null);
});
test('invalid numeric types and ranges cannot masquerade as available decision evidence',()=>{
  for(const [mutate,key] of [
    [i=>i.reference.ema20=0,'ema20'],
    [i=>i.quote.bidPrice='100.95','bidPrice'],
    [i=>i.quote.spreadBps=-1,'spreadBps'],
    [i=>i.reference.averageTurnoverCr=Infinity,'averageTurnoverCr'],
    [i=>i.setup.volumeRatio=NaN,'breakoutVolumeRatio']]){
    const i=input();mutate(i);const d=decisionEvidence(i);
    assert.equal(d.metrics[key].status,'invalid');assert.equal(d.metrics[key].value,null);
    assert.equal(d.readiness.ready,false);assert.ok(d.readiness.missingRequired.includes(key));
  }
  const i=input();i.quote.lastTradeAt=new Date(ms+60000).toISOString();
  const d=decisionEvidence(i);assert.equal(d.metrics.askPrice.status,'missing');
  assert.equal(d.readiness.ready,false);
});
test('all candidates retain diagnostics after the first buy, without a second purchase',()=>{
  const r=transitionSimulation(emptySimulation(),market(['ABC','XYZ']),{at,action:'scan',config:BASELINE_SIM_CONFIG});
  assert.equal(r.state.positions.length,1);assert.equal(r.bought,'ABC');
  assert.ok(r.state.suggestions.every(s=>s.decisionEvidence?.readiness.ready));
  assert.equal(r.state.suggestions[1].status,'not-selected');
  assert.match(r.state.suggestions[1].reasons.join(),/another qualifying entry/);
  assert.deepEqual(r.state.positions[0].decisionEvidence,r.state.suggestions[0].decisionEvidence);
});
test('bad OHLC geometry, conflicting duplicates and NaN cannot produce indicators or authorize an entry',()=>{
  const row=['2026-11-04T04:00:00Z',100,101,99,100,1000];
  for(const bad of [[row[0],100,99,101,100,1000],[row[0],100,101,99,NaN,1000],{0:row[0]}]){
    assert.ok(candleIntegrity([bad]).issues.length);
  }
  assert.equal(candleIntegrity([row,[...row]]).rows.length,1);
  assert.match(candleIntegrity([row,[row[0],100,102,99,101,1000]]).issues.join(),/conflicting/);
  const m=market();m.candles.ABC[0][2]=90;
  assert.equal(transitionSimulation(emptySimulation(),m,{at,action:'scan',config:BASELINE_SIM_CONFIG}).bought,null);
});
test('forming/future bars are ignored; they cannot backfill data available to an earlier decision',()=>{
  const m=market(),before=transitionSimulation(emptySimulation(),m,{at,action:'scan',config:BASELINE_SIM_CONFIG});
  m.candles.ABC.push([new Date(ms+60000).toISOString(),1,999,-1,0,NaN]);
  const after=transitionSimulation(emptySimulation(),m,{at,action:'scan',config:BASELINE_SIM_CONFIG});
  assert.deepEqual(after.state.positions,before.state.positions);
});
test('daily context uses one validated prior-history fetch for RSI, ATR and average volume with honest EMA50 warm-up',()=>{
  const rows=Array.from({length:25},(_,i)=>[`2026-10-${String(i+1).padStart(2,'0')}T00:00:00Z`,100+i,102+i,99+i,101+i,1e6+i]);
  const d=dailyReference(rows,'2026-11-04');assert.equal(d.contextVersion,1);assert.ok(d.rsi14>=0&&d.rsi14<=100);
  assert.ok(d.atr14Pct>0);assert.ok(d.averageVolume>1e6);assert.equal(d.ema50,null);
  rows[0][2]=50;assert.equal(dailyReference(rows,'2026-11-04'),null);
});
test('paper details show saved stop/trigger and evidence, not blank legacy model scores',()=>{
  const state=transitionSimulation(emptySimulation(),market(),{at,action:'scan',config:BASELINE_SIM_CONFIG}).state;
  const rows=simulationSuggestions(state,ms+1000);assert.ok(rows[0].stop>0);assert.ok(rows[0].trigger>0);
  const html=renderSuggestions(rows);assert.match(html,/required inputs recorded/);assert.match(html,/Initial structural stop/);
  assert.doesNotMatch(html,/Current model score|Daily effective score|Latest scan Flow score|Not available/);
  assert.match(html,/not used by this paper strategy/);
  const positions=renderPositions(state.positions,summarizeLedger([],state.positions));assert.doesNotMatch(positions,/Not available/);
});
test('legacy audit recovers only original commit values and never infers the missing order book',()=>{
  const p={id:'entry',ticker:'ABC',date:'2026-11-04',addedAt:at.toISOString(),entryPrice:101,initialStopPrice:99,
    setup:{breakoutLevel:100,signalAt:at.toISOString(),vwap:100.1,volumeRatio:2}};
  const s={updatedAt:new Date(ms+1000).toISOString(),positions:[p],trades:[],dailyCache:{ABC:{asOf:'2026-11-04',ema20:98,averageTurnoverCr:20}},
    lastCheck:{action:'scan',bought:'ABC'},discovery:{benchmark:{changePct:.3,observedAt:at.toISOString()}}};
  const d=recoverDecisionEvidence(p,s,'a'.repeat(40));assert.equal(d.metrics.ema20.value,98);
  assert.equal(d.metrics.spreadBps,undefined);assert.equal(d.readiness,null);assert.equal(d.auditSourceCommit,'a'.repeat(40));
  assert.equal(recoverDecisionEvidence({...p,addedAt:'2026-11-05T04:30:05Z'},s,'a'.repeat(40)),null);
  s.dailyCache.ABC.asOf='2026-11-05';assert.equal(recoverDecisionEvidence(p,s,'a'.repeat(40)).metrics.ema20,undefined);
});
test('legacy UI does not invent confidence or replace entry-time inputs with current measurements',()=>{
  const html=renderDecisionDetails({ticker:'<bad>',status:'Simulated pick',entryPrice:100,stop:98,trigger:99,vwap:98.5,relVol:2,
    entryAt:at.toISOString(),currentReason:'<script>bad</script>'},f);
  assert.match(html,/Legacy trade/);assert.match(html,/&lt;bad&gt;/);assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>|Not available|80% confidence/);assert.match(html,/historical gaps cannot be filled/);
});
