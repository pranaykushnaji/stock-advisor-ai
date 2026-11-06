import test from 'node:test';
import assert from 'node:assert/strict';
import {compareEntryVariants} from '../research/entry-comparison.js';
import {entryCohortPerformance} from '../research/entry-cohorts.js';
import {retainPendingReplayCandidates,publicCandles} from '../research/replay-input.js';
const open=Date.parse('2026-11-04T09:15:00+05:30');
function input(){
  const bars=Array.from({length:6},(_,i)=>[100,100.25,99.95,100+i*.02,1000]);
  bars.push([100.2,100.7,100.19,100.55,2500],[100.4,100.72,100.28,100.68,1400]);
  const minutes=bars=>bars.flatMap((b,i)=>Array.from({length:5},(_,j)=>[new Date(open+i*300000+j*60000).toISOString(),...b.slice(0,4),b[4]/5]));
  const scans=[7,8].map((n,i)=>{const at=new Date(open+n*300000+5000).toISOString();return {at,safetyReady:true,
    suggestions:[{ticker:'ABC',sector:'IT',price:i?100.7:100.55,observedAt:at,
      research:{verified:true,eventPublishedAt:open-3600000}}],
    dailyCache:{ABC:{version:2,asOf:'2026-11-04',return5Pct:3,ema20:99,averageTurnoverCr:20}}};});
  return {date:'2026-11-04',scans,series:{ABC:{candles:minutes(bars),previousClose:99}},
    benchmark:{candles:minutes(bars.map((_,i)=>[100,100.02+i*.01,99.99,100.01+i*.01,0])),previousClose:100}};
}
test('all four entry variants share costs, one-share sizing and point-in-time input; original inputs unchanged',()=>{
  const d=input(),before=structuredClone(d),r=compareEntryVariants([d],{generatedAt:'2026-11-06T10:00:00Z'});
  assert.deepEqual(d,before);assert.equal(r.variants.length,4);
  for(const v of r.variants){assert.equal(v.summary.entries,1,v.mode);assert.equal(v.cohorts['research-backed'].entries,1);
    assert.equal(v.cohorts['price-only'].entries,0);assert.ok(v.summary.netAfterEstimatedLiquidationCosts<0);}
  assert.notEqual(r.variants[0].sessions[0].rows[0].entryAt,r.variants[1].sessions[0].rows[0].entryAt);
  assert.match(r.validationStatus,/INSUFFICIENT/);
});
test('missing historical data is flagged incomplete, never presented as a profitable no-trade day',()=>{
  const d=input();d.series.ABC.candles=[];d.source={historyFailures:{ABC:'missing history'}};
  for(const v of compareEntryVariants([d]).variants){assert.equal(v.sessions[0].status,'incomplete');assert.equal(v.summary.entries,0);}
});
test('pending research candidates remain evaluable after old engine removed them, without borrowing future prices',()=>{
  const d=input();d.scans[1].suggestions=[];
  const r=retainPendingReplayCandidates(d.scans,d.series);
  assert.equal(r.modeledQuotes,1);assert.equal(r.scans[1].suggestions[0].ticker,'ABC');
  assert.equal(r.scans[1].suggestions[0].price,100.68);
  assert.ok(Date.parse(r.scans[1].suggestions[0].observedAt)<=Date.parse(d.scans[1].at));
  assert.equal(d.scans[1].suggestions.length,0);
});
test('actual cohort analytics distinguish entry date, booked exits and open marks; synthetic rows excluded',()=>{
  const state={updatedAt:'2026-11-06T10:00:00Z',trades:[{ticker:'A',date:'2026-11-04',addedAt:'2026-11-04T05:00:00Z',
    exitAt:'2026-11-05T05:00:00Z',investedAmount:100,realizedNetPnl:2,entryCost:.15},
    {ticker:'FAKE',date:'2026-11-04',addedAt:'2026-11-04T05:00:00Z',investedAmount:1,realizedNetPnl:999,synthetic:true}],
    positions:[{ticker:'B',date:'2026-11-06',addedAt:'2026-11-06T05:00:00Z',investedAmount:200,entryCost:.3,shares:1,currentPrice:199,
      researchCohort:'research-backed'}]};
  const groups=entryCohortPerformance(state).groups;assert.equal(groups.length,2);
  assert.equal(groups[0].date,'2026-11-04');assert.equal(groups[0].realizedNet,2);
  assert.equal(groups[1].cohort,'research-backed');assert.equal(groups[1].openMarkedAfterEntryCosts,-1.3);
});
test('historical download is bounded to requested date, not the latest day or mutable meta previousClose',async()=>{
  const original=globalThis.fetch;let requested='';
  globalThis.fetch=async url=>{requested=url;return {ok:true,json:async()=>({chart:{result:[{
    meta:{previousClose:999},timestamp:[Math.floor(open/1000)],indicators:{quote:[{open:[100],high:[101],low:[99],close:[100],volume:[10]}]}}]}})};};
  try{const r=await publicCandles('TEST-ONLY.NS','2026-11-04');
    assert.match(requested,/period1=/);assert.match(requested,/period2=/);assert.doesNotMatch(requested,/range=1d/);
    assert.equal(r.candles.length,1);assert.equal(r.previousClose,undefined);
  }finally{globalThis.fetch=original;}
});
