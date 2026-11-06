// Display original decision inputs only. Never fetch today's data to fill a past
// trade's blanks or turn an unused score into an invented confidence percentage.
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export function savedDecisionMetrics(row){
  if([0,1].includes(row.decisionEvidence?.version))return row.decisionEvidence;
  const metrics={},at=row.entryAt||row.chosenAt;
  for(const [key,label,value,unit] of [
    ['entryPrice','Recorded paper entry',row.entryPrice,'INR'],
    ['initialStop','Frozen initial stop',row.stop,'INR'],
    ['vwap','Signal VWAP · OHLC approximation',row.vwap,'INR'],
    ['breakoutLevel','Recorded breakout level',row.trigger,'INR'],
    ['breakoutVolumeRatio','Breakout volume / preceding range average',row.relVol,'×']])
    if(finite(value))metrics[key]={label,value,unit,status:'available',asOf:at,source:'Original saved setup / paper trade',required:false};
  return {version:0,asOf:at,metrics,scope:'Legacy saved evidence; complete decision inputs were not retained',
    readiness:null,notUsed:['Legacy model / flow / institutional scores','Calibrated probability of profit']};
}
export function renderDecisionDetails(row,{e,money,decimal,percent,dateTime}){
  const evidence=savedDecisionMetrics(row),entries=Object.entries(evidence.metrics||{}),ready=evidence.readiness;
  const available=entries.filter(([,m])=>m.status==='available'&&(finite(m.value)||typeof m.value==='boolean'));
  const missing=entries.filter(([,m])=>m.required&&m.status!=='available');
  const optional=entries.filter(([,m])=>!m.required&&m.status!=='available');
  const format=m=>m.unit==='INR'?money(m.value):m.unit==='%'?percent(m.value):m.unit==='boolean'?(m.value?'Yes':'No'):
    `${decimal(m.value)}${m.unit==='×'?'×':m.unit==='₹ Cr'?' Cr':m.unit==='bp'?' bp':m.unit==='s'?' s':m.unit==='/100'?'/100':''}`;
  const picked=row.status==='Simulated pick';
  const summary=ready?`${ready.requiredAvailable}/${ready.requiredTotal} required inputs recorded`:
    picked?'Legacy trade: only the original saved fields can be verified':row.price==null?'Premarket watch: awaiting executable market data':'Discovery watch: full decision evidence not retained';
  const when=typeof evidence.asOf==='string'?dateTime(evidence.asOf):'original timestamp not retained';
  return `<details class="decision-evidence"><summary>Research details for ${e(row.ticker)}</summary><div class="details-body">
    <p class="evidence-heading"><strong>${e(summary)}</strong></p>
    <p>${e(row.currentReason||'Watch only; no purchase established.')}</p>
    <p class="small">Decision input time: ${e(when)}. ${e(evidence.scope)}. Completeness does not mean the strategy approved a buy.</p>
    ${evidence.auditSourceCommit&&/^[a-f0-9]{40}$/.test(evidence.auditSourceCommit)?`<p class="small"><a href="https://github.com/pranaykushnaji/stock-advisor-ai/blob/${e(evidence.auditSourceCommit)}/data/paper-simulation.json" target="_blank" rel="noopener noreferrer">View original decision record</a></p>`:''}
    ${row.marketCapBucket||row.mappingStatus?`<p class="small">Current registry: ${e(row.marketCapBucket||'classification not supplied')} · ${e(row.mappingStatus||'mapping not supplied')}. Current membership is not historical entry evidence.</p>`:''}
    ${row.entryAssessment?.setup?.confirmationType?`<p><strong>Confirmation:</strong> ${e(row.entryAssessment.setup.confirmationType)} · ${e(dateTime(row.entryAssessment.setup.confirmationAt))}</p>`:''}
    ${available.length?`<h3>Recorded measurements</h3><dl class="evidence-metrics">${available.map(([key,m])=>`<div data-metric="${e(key)}"><dt>${e(m.label)}${m.required?' · required':''}</dt><dd>${e(format(m))}</dd><p>${e(m.source)} · ${e(typeof m.asOf==='string'?dateTime(m.asOf):'timestamp not retained')}</p></div>`).join('')}</dl>`:
      '<p>No full measurement set was retained for this watch. This is not a buy recommendation.</p>'}
    ${missing.length?`<div class="notice warning"><strong>Missing required inputs — no new buy permitted</strong><ul>${missing.map(([,m])=>`<li>${e(m.label)}: ${e(m.reason||'source input missing')}</li>`).join('')}</ul></div>`:''}
    ${ready?.invalidInputs?.length?`<div class="notice warning"><strong>Invalid source data</strong><ul>${ready.invalidInputs.map(s=>`<li>${e(s)}</li>`).join('')}</ul></div>`:''}
    ${evidence.version===0?'<p class="notice">Earlier records did not retain the complete daily baseline and order book. Those historical gaps cannot be filled with current values. New entries must retain their required evidence.</p>':''}
    ${optional.length?`<p class="small">Optional context not used to authorize this trade: ${optional.map(([,m])=>`${e(m.label)} — ${e(m.reason)}`).join('; ')}.</p>`:''}
    <p class="small divider">${e((evidence.notUsed||[]).join('; '))}: not used by this paper strategy, not missing buy criteria. A volume spike is not proof of institutional buying.</p>
    <p class="small">Research: ${e(row.researchCohort||'price-only / historical cohort not recorded')}. ${e(row.research?.summary||'No verified positive event linked to this record. Price-only entries do not claim a catalyst.')} ${picked?'A paper fill was recorded; no broker order was placed.':'A watch or suggestion is not an executed trade.'}</p>
    <p class="small">${e(row.expired?'Saved setup has expired.':'Setup must pass current checks before any entry.')}</p>
  </div></details>`;
}
