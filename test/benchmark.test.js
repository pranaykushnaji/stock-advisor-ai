import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFullQuotes,benchmarkObservation,quoteFreshness} from '../api/_upstox-market-data.js';
const key='NSE_INDEX|Nifty 50',now=Date.parse('2026-11-04T06:35:00Z');
test('calculated Nifty uses its provider snapshot timestamp, not a nonexistent trade or local receipt time',async()=>{
  const q=(await fetchFullQuotes([key],{token:'test',fetchImpl:async()=>Response.json({status:'success',data:{
    'NSE_INDEX:Nifty 50':{last_price:26000,net_change:100,prev_close_price:0,timestamp:new Date(now).toISOString(),last_trade_time:'0'}
  }})}))[key];
  assert.equal(q.previousClose,25900);assert.equal(q.lastTradeAt,null);
  assert.equal(benchmarkObservation(q,{nowMs:now}).fresh,true);
  assert.equal(quoteFreshness(q,{nowMs:now}).fresh,false);
  assert.equal(benchmarkObservation({...q,responseAt:new Date(now-100000).toISOString()},{nowMs:now}).fresh,false);
  assert.equal(benchmarkObservation({...q,instrumentKey:'NSE_EQ|ABC'},{nowMs:now}).fresh,false);
  assert.equal(benchmarkObservation({...q,responseAt:null},{nowMs:now}).fresh,false);
});
test('fresh stock LTP without a real last-trade timestamp remains non-executable',async()=>{
  const stock='NSE_EQ|INE745G01043';
  const q=(await fetchFullQuotes([stock],{token:'test',fetchImpl:async()=>Response.json({status:'success',data:{
    display:{instrument_token:stock,symbol:'MCX',last_price:100,prev_close_price:99,timestamp:new Date(now).toISOString()}
  }})}))[stock];
  assert.equal(quoteFreshness(q,{nowMs:now}).fresh,false);
  assert.equal(benchmarkObservation(q,{nowMs:now}).fresh,false);
});
