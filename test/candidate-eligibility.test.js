import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateEligibilityReasons, selectEligibleCandidate } from '../api/_candidate-eligibility.js';

const candidate = (symbol, overrides = {}) => ({
  symbol, lane: 'catalyst', effectiveConfidence: 75, confidence: 70,
  rewardRisk: { rr: 2 }, expectedEdge: { edgePct: 1 }, ...overrides,
});
const context = (overrides = {}) => ({
  fresh: true, concentration: { action: 'ok', factor: 1, reason: null },
  gates: { minConfidence: 62, minRR: 1.8, requireVerified: false },
  regime: { regime: 'neutral' }, catalyst: { verification: 'VERIFIED' },
  momentumConfidenceExtra: 6, ...overrides,
});

for (const [name, overrides, reason] of [
  ['confidence', { effectiveConfidence: 61.9 }, /confidence 61.9 < 62/],
  ['reward/risk', { rewardRisk: { rr: 1.79 } }, /reward\/risk 1.79 < 1.8/],
  ['negative edge', { expectedEdge: { edgePct: -1.34 } }, /historical net edge -1.34% ≤ 0/],
  ['zero edge', { expectedEdge: { edgePct: 0 } }, /historical net edge 0% ≤ 0/],
  ['insufficient edge evidence', { expectedEdge: { edgePct: null, reason: 'need 20 comparable completed trades; have 4' } }, /need 20 comparable completed trades; have 4/],
]) {
  test(`a first candidate failing ${name} does not block an eligible runner-up`, () => {
    const first = candidate('FIRST', overrides), second = candidate('SECOND');
    const rejections = [];
    const result = selectEligibleCandidate([first, second], () => context(), e => rejections.push(e));
    assert.equal(result.winner, second);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0].candidate, first);
    assert.match(rejections[0].reasons.join('; '), reason);
  });
}

test('all nonpositive or missing historical edges still produce no winner', () => {
  const rows = [null, undefined, { edgePct: null }, { edgePct: 0 }, { edgePct: -1.34 }]
    .map((expectedEdge, i) => candidate(`T${i}`, { expectedEdge }));
  const logged = [];
  const result = selectEligibleCandidate(rows, () => context(), e => logged.push(e.candidate.symbol));
  assert.equal(result.winner, undefined);
  assert.deepEqual(logged, rows.map(r => r.symbol));
  assert.ok(result.evaluated.every(e => e.reasons.length > 0));
});

for (const [field, overridesFor, reason] of [
  ['confidence', value => ({ effectiveConfidence: value }), 'confidence is not a finite number'],
  ['reward/risk', value => ({ rewardRisk: { rr: value } }), 'reward/risk is not a finite number'],
  ['edge', value => ({ expectedEdge: { edgePct: value } }), 'historical net edge is not a finite number'],
]) {
  for (const value of [NaN, Infinity, -Infinity, '99']) {
    test(`${field} rejects ${String(value)} (${typeof value}) and permits an eligible runner-up`, () => {
      const bad = candidate('BAD', overridesFor(value)), good = candidate('GOOD');
      const logged = [];
      const result = selectEligibleCandidate([bad, good], () => context(), e => logged.push(e));
      assert.equal(result.winner, good);
      assert.equal(logged.length, 1);
      assert.deepEqual(logged[0].reasons, [reason]);
      assert.equal(selectEligibleCandidate([bad], () => context()).winner, undefined);
    });
  }
}

test('non-finite legacy confidence cannot bypass validation through the fallback', () => {
  for (const confidence of [NaN, Infinity, -Infinity, '99']) {
    const r = candidate('LEGACY', { effectiveConfidence: null, confidence });
    assert.deepEqual(candidateEligibilityReasons(r, context()), ['confidence is not a finite number']);
  }
});

test('freshness and concentration remain binding; reductions remain eligible', () => {
  const rows = ['HELD', 'CONCENTRATED', 'REDUCED', 'LATER'].map(s => candidate(s));
  const result = selectEligibleCandidate(rows, r => context({
    fresh: r.symbol !== 'HELD',
    concentration: r.symbol === 'CONCENTRATED'
      ? { action: 'reject', factor: 0, reason: 'concentration limit' }
      : { action: 'reduce', factor: 0.5, reason: 'size halved' },
  }));
  assert.equal(result.winner, rows[2]);
  assert.deepEqual(result.evaluated[0].reasons, ['already held or traded today']);
  assert.deepEqual(result.evaluated[1].reasons, ['concentration limit']);
  assert.deepEqual(result.evaluated[2].reasons, []);
});

test('lane thresholds, equality boundaries and legacy confidence fallback are preserved', () => {
  const ctx = context();
  assert.deepEqual(candidateEligibilityReasons(candidate('CAT', { effectiveConfidence: 62, rewardRisk: { rr: 1.8 } }), ctx), []);
  assert.match(candidateEligibilityReasons(candidate('MOM', { lane: 'momentum', effectiveConfidence: 67.9 }), ctx)[0], /< 68 \(momentum-lane bar\)/);
  assert.deepEqual(candidateEligibilityReasons(candidate('MOM', { lane: 'momentum', effectiveConfidence: 68 }), ctx), []);
  assert.deepEqual(candidateEligibilityReasons(candidate('LEGACY', { lane: undefined, effectiveConfidence: null, confidence: 62 }), ctx), []);
  assert.match(candidateEligibilityReasons(candidate('NO_RR', { rewardRisk: null }), ctx)[0], /reward\/risk 0 < 1.8/);
});

test('weak-market catalyst verification still blocks an otherwise eligible candidate', () => {
  const ctx = context({ gates: { minConfidence: 72, minRR: 2.2, requireVerified: true },
    regime: { regime: 'weak' }, catalyst: { verification: 'PARTIAL' } });
  const r = candidate('CAT', { rewardRisk: { rr: 2.2 } });
  assert.deepEqual(candidateEligibilityReasons(r, ctx), ['catalyst PARTIAL (need VERIFIED in weak market)']);
  assert.deepEqual(candidateEligibilityReasons(r, { ...ctx, catalyst: { verification: 'VERIFIED' } }), []);
});

test('lower-ranked rejections are logged and first eligible wins without reranking or mutation', () => {
  const rows = [candidate('FIRST'), candidate('LATER', { effectiveConfidence: 99 }),
    candidate('REJECTED', { expectedEdge: null })];
  const ctx = context(), before = JSON.stringify({ rows, ctx });
  let logged = false;
  const result = selectEligibleCandidate(rows, () => ctx, e => {
    assert.equal(e.candidate.symbol, 'REJECTED'); logged = true;
  });
  assert.equal(logged, true);
  assert.equal(result.winner, rows[0]);
  assert.equal(JSON.stringify({ rows, ctx }), before);
  assert.equal(selectEligibleCandidate([], () => ctx).winner, undefined);
});
