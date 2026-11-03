// Final eligibility only: callers retain the existing lane assignment and ranking.
export function candidateEligibilityReasons(candidate, {
  fresh, concentration, gates, regime, catalyst, momentumConfidenceExtra,
}) {
  const reasons = [];
  const confidence = candidate.effectiveConfidence ?? candidate.confidence ?? 0;
  const lane = candidate.lane || 'catalyst';
  const confBar = lane === 'momentum' ? gates.minConfidence + momentumConfidenceExtra : gates.minConfidence;
  const rr = candidate.rewardRisk?.rr ?? 0;
  if (!fresh) reasons.push('already held or traded today');
  if (!Number.isFinite(confidence)) reasons.push('confidence is not a finite number');
  else if (confidence < confBar) reasons.push(`confidence ${+confidence.toFixed(1)} < ${confBar}${lane === 'momentum' ? ' (momentum-lane bar)' : ''}`);
  if (!Number.isFinite(rr)) reasons.push('reward/risk is not a finite number');
  else if (rr < gates.minRR) reasons.push(`reward/risk ${rr} < ${gates.minRR}`);
  if (lane === 'catalyst' && gates.requireVerified && catalyst?.verification !== 'VERIFIED') {
    reasons.push(`catalyst ${catalyst?.verification || 'UNVERIFIED'} (need VERIFIED in ${regime.regime} market)`);
  }
  if (candidate.expectedEdge?.edgePct == null) reasons.push(candidate.expectedEdge?.reason || 'insufficient payoff evidence');
  else if (!Number.isFinite(candidate.expectedEdge.edgePct)) reasons.push('historical net edge is not a finite number');
  else if (candidate.expectedEdge.edgePct <= 0) reasons.push(`historical net edge ${candidate.expectedEdge.edgePct}% ≤ 0`);
  if (concentration?.action === 'reject') reasons.push(concentration.reason);
  return reasons;
}

// Evaluate and log every rejected candidate before choosing; never reorder the input.
export function selectEligibleCandidate(ranked, contextFor, onRejected = () => {}) {
  const evaluated = ranked.map(candidate => {
    const context = contextFor(candidate);
    const reasons = candidateEligibilityReasons(candidate, context);
    const result = { candidate, context, reasons };
    if (reasons.length) onRejected(result);
    return result;
  });
  return { winner: evaluated.find(e => e.reasons.length === 0)?.candidate, evaluated };
}
