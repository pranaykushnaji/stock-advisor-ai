// Explain BOTH existing lanes without changing their thresholds or selection order.
export function entryLaneDiagnostics(s, { regime, gates, momLaneOpen, momentum, catalystMin = 2.1 }) {
  const rv = s._qm?.relVol, cat = s._catalyst;
  const catalyst = [], mom = [];
  if (cat?.negative) { catalyst.push('negative catalyst'); mom.push('negative catalyst'); }
  if (!(rv >= catalystMin)) catalyst.push(`relVol ${rv ?? 'n/a'}<${catalystMin}`);
  if (!cat?.hasCatalyst) catalyst.push(`catalyst ${cat?.verification || 'UNVERIFIED'} (need VERIFIED)`);
  if (!momentum.REGIMES.includes(regime.regime)) mom.push(`momentum lane disabled in ${regime.regime} regime`);
  else if (!momLaneOpen) mom.push('momentum daily limit reached');
  if (!(rv >= momentum.MIN_RELVOL)) mom.push(`relVol ${rv ?? 'n/a'}<${momentum.MIN_RELVOL}`);
  if (!((s._effConfMom ?? 0) >= gates.minConfidence + momentum.CONF_EXTRA)) {
    mom.push(`momentum confidence ${s._effConfMom ?? 0}<${gates.minConfidence + momentum.CONF_EXTRA}`);
  }
  if (!((s._inst?.score ?? 0) >= momentum.MIN_INSTITUTIONAL)) mom.push(`accumulation proxy ${s._inst?.score ?? 0}<${momentum.MIN_INSTITUTIONAL}`);
  return { catalyst: { eligible: catalyst.length === 0, reasons: catalyst },
    momentum: { eligible: mom.length === 0, reasons: mom },
    momentumConfidence: s._effConfMom, catalystConfidence: s._effConfCat };
}
