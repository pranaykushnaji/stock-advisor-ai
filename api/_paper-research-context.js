// Reuse saved morning research; never turn an advisor headline into a verified event.
const stamp = value => typeof value === 'number' ? value : Date.parse(value);
const recent = (value, now, hours) => Number.isFinite(stamp(value)) && stamp(value) <= now && now-stamp(value) <= hours*3600000;
const text = value => String(value || '').slice(0,600);
export function verifiedResearchEvent(c, nowMs) {
  if (!c || c.verification !== 'VERIFIED' || c.evidenceVersion !== 2) return false;
  // firstSeenMs is the original evidence time in the persisted catalyst schema. Never
  // refresh an old event from the watchlist build time or lastConfirmedMs alone.
  if (!recent(c.eventPublishedAt ?? c.firstSeenMs, nowMs, 72)) return false;
  const evidence=Array.isArray(c.evidence)?c.evidence:[];
  if(evidence.some(e=>['nse-filing','bse-filing'].includes(e.publisher)&&e.title))return true;
  const hosts=new Set(),titles=new Set();
  for(const e of evidence){
    try{const u=new URL(e.url),title=text(e.title).toLowerCase().trim();
      if(!['https:','http:'].includes(u.protocol)||!title||titles.has(title))continue;
      titles.add(title);hosts.add(u.hostname.toLowerCase().replace(/^www\./,''));
    }catch{/* Publisher names without source links are not corroboration. */}
  }
  return hosts.size>=2;
}
export function savedResearchContext({watchlist={},intel={},memory={}}={}, at, members=[]) {
  const now=at.getTime(),date=new Date(now+19800000).toISOString().slice(0,10);
  const allowed=new Map(members.filter(m=>m.instrumentKey&&['mid','small'].includes(m.marketCapBucket)).map(m=>[m.symbol,m]));
  const bySymbol={},negativeSymbols=[];
  function add(symbol,c,source,observedAt,{advisor=false}={}){
    if(!allowed.has(symbol))return;
    const verified=!advisor&&verifiedResearchEvent(c,now);
    const negative=verified&&c.negative===true;
    if(negative)negativeSymbols.push(symbol);
    const usable=verified&&!negative&&(c.hasCatalyst===true||(c.stars>=3&&c.impactClass?.endsWith('+')));
    const row={source,observedAt,verified:usable,negative,type:text(c.type||c.eventType)||'research watch',
      summary:text(c.summary),eventPublishedAt:c.eventPublishedAt??c.firstSeenMs??null,
      verification:verified?'VERIFIED':'ADVISOR / UNVERIFIED'};
    if(!bySymbol[symbol]||usable||negative)bySymbol[symbol]=row;
  }
  for(const [symbol,c] of Object.entries(memory.catalysts||{})){
    const event=c.catalyst||c;
    if(verifiedResearchEvent(event,now))add(symbol,event,'verified catalyst memory',new Date(stamp(event.eventPublishedAt??event.firstSeenMs)).toISOString());
  }
  if(watchlist.date===date&&recent(watchlist.builtAt,now,12)){
    for(const w of watchlist.watch||[])add(w.ticker,w.catalyst||{},'morning research',watchlist.builtAt);
  }
  if(recent(intel.generatedAt,now,12)){
    for(const item of intel.items||[])if(recent(item.publishedAt,now,72))add(item.ticker,item,'saved news advisor',intel.generatedAt,{advisor:true});
  }
  return {researchBySymbol:bySymbol,negativeSymbols:[...new Set(negativeSymbols)],researchAt:at.toISOString()};
}
