import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFullQuotes} from '../api/_upstox-market-data.js';
const key='NSE_EQ|INE745G01043';
const get=depth=>fetchFullQuotes([key],{token:'fixture-only',fetchImpl:async()=>new Response(JSON.stringify({status:'success',data:{MCX:{
  instrument_token:key,symbol:'MCX',last_price:100,last_trade_time:Date.parse('2026-11-03T04:00:00Z'),timestamp:'2026-11-03T04:00:00Z',
  average_price:99,upper_circuit_limit:120,lower_circuit_limit:80,year_high:110,year_low:60,ohlc:{open:98,high:101,low:97},depth,
}}}),{status:200})});
test('Upstox research retains official circuit bands, day range and valid executable-side depth',async()=>{
  const {[key]:q}=await get({buy:[{price:99,quantity:5},{price:99.9,quantity:10}],sell:[{price:101,quantity:5},{price:100.1,quantity:10}]});
  assert.equal(q.bidPrice,99.9);assert.equal(q.askPrice,100.1);assert.ok(Math.abs(q.spreadBps-20)<1e-9);
  assert.equal(q.upperCircuit,120);assert.equal(q.dayOpen,98);assert.equal(q.yearHigh,110);assert.equal(q.averagePrice,99);
});
test('crossed, empty or zero-quantity depth is unknown, not perfect liquidity',async()=>{
  for(const depth of [undefined,{buy:[{price:101,quantity:10}],sell:[{price:100,quantity:10}]},{buy:[{price:99,quantity:0}],sell:[{price:100,quantity:0}]}]){
    const {[key]:q}=await get(depth);assert.equal(q.spreadBps,null);assert.equal(q.askPrice,null);assert.equal(q.bidPrice,null);
  }
});
