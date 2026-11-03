import test from 'node:test';
import assert from 'node:assert/strict';
import { sameTimeRelativeVolume, researchPositionPlan, researchExitObservation } from '../research/paper-plan.js';
const nowMs = Date.parse('2026-11-03T04:00:00Z');
const quote = { price: 100, lastTradeAt: new Date(nowMs).toISOString(), responseAt: new Date(nowMs).toISOString() };
const budget = { entryPrice: 100, stopPrice: 98, quote, nowMs, riskBudget: 100,
  remainingDailyLossBudget: 100, remainingDailyInvestmentBudget: 2000, cashAvailable: 10000, remainingExposureBudget: 10000 };
test('research sizing caps WHOLE shares by capital and risk; no minimum allocation override', () => {
  const p = researchPositionPlan(budget);
  assert.equal(p.shares, 19); assert.ok(p.investedAmount <= 2000); assert.ok(p.estimatedStopLoss <= 100);
  assert.equal(researchPositionPlan({...budget,remainingDailyInvestmentBudget:50}).shares,0);
  assert.equal(researchPositionPlan({...budget,riskBudget:1}).shares,0);
});
test('missing budgets and stale or non-current proposed entries fail closed', () => {
  assert.equal(researchPositionPlan({...budget,riskBudget:undefined}).status,'blocked');
  assert.equal(researchPositionPlan({...budget,nowMs:nowMs+100000}).status,'blocked');
  assert.equal(researchPositionPlan({...budget,entryPrice:90}).status,'blocked');
});
test('cost-aware experimental trail arms in risk units without loosening the original stop', () => {
  const p = {id:'2026-11-03|ABC',entryPrice:100,initialStopPrice:98};
  const r = researchExitObservation(p,{...quote,price:103},{nowMs});
  assert.equal(r.status,'hold'); assert.equal(r.state.trailingStopPrice,101);
  assert.equal(p.trailingStopPrice,undefined); assert.equal(r.state.initialStopPrice,98);
  const q = {...quote,price:100.5,lastTradeAt:new Date(nowMs+60000).toISOString(),responseAt:new Date(nowMs+60000).toISOString()};
  const sold = researchExitObservation(r.state,q,{nowMs:nowMs+60000});
  assert.equal(sold.status,'exit-proposed'); assert.equal(sold.decision.observedFillPrice,100.5);
  const recovery = {...q,price:105,lastTradeAt:new Date(nowMs+120000).toISOString(),responseAt:new Date(nowMs+120000).toISOString()};
  assert.equal(researchExitObservation(sold.state,recovery,{nowMs:nowMs+120000}).status,'exit-latched');
});
test('gap exits use observed worse price; stale quotes cannot trigger or raise peaks', () => {
  const p={id:'x',entryPrice:100,initialStopPrice:98};
  const r=researchExitObservation(p,{...quote,price:95},{nowMs});
  assert.equal(r.decision.observedFillPrice,95); assert.ok(r.decision.estimatedNetReturnPct < -5);
  assert.equal(researchExitObservation(p,quote,{nowMs:nowMs+100000}).status,'unavailable');
});
test('same-time volume rejects incomplete references rather than assuming linear session volume', () => {
  const session = date => Array.from({length:15},(_,i)=>({ms:Date.parse(`${date}T03:45:00Z`)+i*60000,volume:100}));
  const history=['2026-11-02','2026-10-30'].flatMap(session),current=session('2026-11-03').map(x=>({...x,volume:200}));
  const r=sameTimeRelativeVolume({current,history,nowMs,minimumSessions:2});
  assert.equal(r.ratio,2); assert.equal(r.completedMinutes,15);
  assert.equal(sameTimeRelativeVolume({current:current.slice(1),history,nowMs,minimumSessions:2}).status,'unavailable');
  assert.equal(sameTimeRelativeVolume({current,history:history.slice(1),nowMs,minimumSessions:2}).status,'unavailable');
});
