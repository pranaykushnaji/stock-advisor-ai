import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeQuoteCoverage} from '../research/quote-coverage.js';
const now=new Date('2026-11-03T04:00:00Z'),key='NSE_EQ|INE745G01043';
const manifest={fetchedAt:now.toISOString(),members:[{symbol:'MCX',instrumentKey:key,marketCapBucket:'mid'}]};
test('wide quote diagnostic does not label stale or wrong-identity quotes usable',()=>{
  const quote={instrumentKey:key,symbol:'MCX',price:100,previousClose:95,lastTradeAt:now.toISOString(),responseAt:now.toISOString()};
  const good=summarizeQuoteCoverage(manifest,{[key]:quote},now);
  assert.equal(good.summary.fresh,1);assert.equal(good.rows[0].eligibleToTrade,false);assert.equal(good.rows[0].relativeVolume,null);
  assert.equal(summarizeQuoteCoverage(manifest,{[key]:{...quote,symbol:'OTHER'}},now).summary.received,0);
  assert.equal(summarizeQuoteCoverage(manifest,{[key]:quote},new Date(now.getTime()+100000)).summary.fresh,0);
});
