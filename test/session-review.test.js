import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewPaperSession} from '../research/session-review.js';
test('review deduplicates scans, distinguishes scan repetition from buys, and does not call cap-only rows eligible',()=>{
  const s={updatedAt:'2026-11-05T04:50:00Z',lastCheck:{action:'scan',bought:null},days:{'2026-11-05':{invested:9819.15}},suggestions:[{ticker:'X',price:200,observedAt:'2026-11-05T04:50:00Z',entryDiagnostics:{status:'setup'},reasons:['three daily positions already opened']}]};
  const next=structuredClone(s);next.updatedAt='2026-11-05T04:55:00Z';next.suggestions[0].price=210;next.suggestions[0].observedAt=next.updatedAt;
  const r=reviewPaperSession([next,s,s],'2026-11-05');
  assert.equal(r.scans,2);assert.equal(r.distinctSuggestions,1);assert.equal(r.buys.length,0);assert.equal(r.cappedSetups.length,2);
  assert.equal(r.cappedSetups[0].cannotAffordEvenAtLastPrice,true);assert.equal(r.cappedSetups[0].onlyRecordedBlocker,true);
  assert.ok(Math.abs(r.candidates[0].maxObservedRisePct-5)<1e-8);assert.match(r.limitations[1],/do not establish full eligibility/);
});
