// Independently written, deterministic PAPER experiment. Thresholds are hypotheses,
// not optimized settings or probabilities. Every lane uses the same risk/data gates.
import {completedFiveMinuteBars} from '../api/_entry-research.js';
import {assessPaperEntry,researchCohort} from './entry-quality.js';

export const SETUP_TYPES=Object.freeze(['compression-breakout','trend-pullback','catalyst-continuation']);
export const SETUP_RULES=Object.freeze({version:'three-setups-v1',minimumBars:8,
  maxRangePct:1.5,contractionRatio:.8,dryingVolumeRatio:.9,minVolumeRatio:1.5,
  minimumCloseLocation:.65,pullbackTouchPct:.2,maxPullbackPct:1.5});
const STEP=300000,avg=a=>a.reduce((s,n)=>s+n,0)/a.length,pct=(a,b)=>(a/b-1)*100;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const ema=a=>a.reduce((v,n,i)=>i?n/3+v*2/3:n,0);
export function assessTradingSetups({candles,quote,reference,marketContext,research,now=new Date(),fillPrice=quote?.price,
  allowedTypes=SETUP_TYPES}={}){
  if(!Array.isArray(allowedTypes)||!allowedTypes.length||allowedTypes.some(t=>!SETUP_TYPES.includes(t)))throw Error('Invalid setup lanes');
  const bars=completedFiveMinuteBars(candles,now),boundary=Math.floor(now.getTime()/STEP)*STEP;
  const recent=bars.slice(-SETUP_RULES.minimumBars),end=recent.at(-1),prior=recent.slice(0,-1),pb=recent.slice(-3,-1),impulse=recent.slice(0,-3);
  const range=prior.length?{high:Math.max(...prior.map(b=>b.high)),low:Math.min(...prior.map(b=>b.low))}:{};
  let pv=0,volume=0;for(const b of bars){pv+=(b.high+b.low+b.close)/3*b.volume;volume+=b.volume;}
  const vwap=volume>0?pv/volume:null,shortEma=bars.length?ema(bars.map(b=>b.close)):null;
  const quoteTime=Date.parse(quote?.lastTradeAt),fresh=finite(quoteTime)&&quoteTime>=boundary&&quoteTime<=now.getTime();
  const contiguous=recent.length===SETUP_RULES.minimumBars&&recent.every((b,i)=>!i||b.ms-recent[i-1].ms===STEP);
  const latest=!!end&&end.ms+STEP===boundary&&now.getTime()-boundary<=90000;
  const strong=!!end&&end.high>end.low&&end.close>end.open&&(end.close-end.low)/(end.high-end.low)>=SETUP_RULES.minimumCloseLocation;
  const first=prior.slice(0,3),last=prior.slice(-3);
  const rangeMean=a=>a.length?avg(a.map(b=>b.high-b.low)):null;
  const volumeMean=a=>a.length?avg(a.map(b=>b.volume)):null;
  const lanes=allowedTypes.map(type=>{
    const checks=[];const check=(label,passed,measurement=null)=>checks.push({label,passed:passed===true,measurement:finite(measurement)?measurement:null});
    const isPullback=type==='trend-pullback',level=isPullback?pb.at(-1)?.high:range.high;
    const support=isPullback?Math.min(...[...pb,...(end?[end]:[])].map(b=>b.low)):range.low;
    const baseVolume=volumeMean(isPullback?pb:prior),volumeRatio=baseVolume>0&&end?end.volume/baseVolume:null;
    check('Eight contiguous completed five-minute bars',contiguous);
    check('Fresh completed signal and subsequent execution quote',latest&&fresh);
    check('Strong positive signal close',strong);
    check('Close and executable price above trigger',end?.close>level&&fillPrice>=end?.close*.9995&&fillPrice>=level);
    check('At least 1.5× preceding setup-bar volume',volumeRatio>=SETUP_RULES.minVolumeRatio,volumeRatio);
    check('Above session VWAP and prior daily EMA20',vwap>0&&fillPrice>=vwap&&reference?.ema20>0&&fillPrice>reference.ema20);
    if(type==='compression-breakout'){
      const contraction=rangeMean(first)>0?rangeMean(last)/rangeMean(first):null;
      const drying=volumeMean(first)>0?volumeMean(last)/volumeMean(first):null;
      check('Consolidation no wider than 1.5%',range.low>0&&pct(range.high,range.low)<=SETUP_RULES.maxRangePct,pct(range.high,range.low));
      check('Recent range contracts to 80% or less',finite(contraction)&&contraction<=SETUP_RULES.contractionRatio,contraction);
      check('Volume dries to 90% or less before breakout',finite(drying)&&drying<=SETUP_RULES.dryingVolumeRatio,drying);
      check('Consolidation lows are not deteriorating',last.length===3&&Math.min(...last.map(b=>b.low))>=Math.min(...first.map(b=>b.low)));
    }else if(isPullback){
      const peak=impulse.length?Math.max(...impulse.map(b=>b.high)):null,low=pb.length?Math.min(...pb.map(b=>b.low)):null;
      check('Established rising impulse before pullback',impulse.length===5&&impulse.at(-1).close>impulse[0].close);
      check('Controlled pullback of no more than 1.5%',peak>low&&low>0&&pct(peak,low)<=SETUP_RULES.maxPullbackPct,pct(peak,low));
      check('Pullback actually retraces from prior impulse',pb.length===2&&pb.some(b=>b.close<impulse.at(-1)?.close));
      check('Pullback holds VWAP or touches short EMA',low>0&&vwap>0&&low>=vwap*(1-SETUP_RULES.pullbackTouchPct/100)
        &&low<=Math.max(vwap,shortEma)*(1+SETUP_RULES.pullbackTouchPct/100));
      check('Pullback volume contracts versus impulse',volumeMean(impulse)>0&&volumeMean(pb)<volumeMean(impulse));
    }else{
      check('Fresh verified positive company-specific event',researchCohort(research,now)==='research-backed');
      const published=typeof research?.eventPublishedAt==='number'?research.eventPublishedAt:Date.parse(research?.eventPublishedAt);
      check('Event was known before the signal began',finite(published)&&!!end&&published<=end.ms);
      check('Bounded consolidation before continuation',range.low>0&&pct(range.high,range.low)<=SETUP_RULES.maxRangePct,pct(range.high,range.low));
    }
    const failures=checks.filter(c=>!c.passed).map(c=>c.label);
    const proposed={status:failures.length?'no_setup':'setup',reason:failures.join('; '),
      signalAt:end?new Date(end.ms+STEP).toISOString():null,entryAt:quote?.lastTradeAt,
      entryPrice:fillPrice,breakoutLevel:level??null,supportLevel:finite(support)?support:null,
      vwap,volumeRatio,setupVersion:SETUP_RULES.version,setupType:type,confirmationType:type,
      confirmationAt:end?new Date(end.ms+STEP).toISOString():null};
    const assessment=assessPaperEntry({candles,quote,reference,marketContext,now,fillPrice,setupOverride:proposed});
    return {type,label:setupLabel(type),status:assessment.status,checks,assessment,
      trigger:finite(level)?level:null,invalidation:finite(support)&&support>0?support*.999:null,
      extensionPct:level>0&&fillPrice>0?pct(fillPrice,level):null,
      missingConfirmation:[...new Set([...failures,...assessment.reasons])],
      researchStatus:researchCohort(research,now),asOf:now.toISOString()};
  });
  // Fixed preregistered priority, not the lane with most correlated indicator votes.
  const priority=['catalyst-continuation','compression-breakout','trend-pullback'];
  const selected=priority.map(type=>lanes.find(l=>l.type===type&&l.status==='qualified')).find(Boolean)??null;
  return {version:SETUP_RULES.version,asOf:now.toISOString(),selectedType:selected?.type??null,
    // Retain measured trigger/support even when market context blocks the trade.
    // This is diagnostic evidence, NOT permission to bypass a failed lane.
    assessment:selected?.assessment??lanes[0]?.assessment??null,lanes};
}
export function setupLabel(type){return {'compression-breakout':'Compression breakout','trend-pullback':'Trend pullback / recovery',
  'catalyst-continuation':'Verified catalyst continuation'}[type]||'Original consolidation';}

// Bounded rotation broadens research beyond the same highest-ranked names. It
// never bypasses discovery exclusions, fetches more names, or guarantees a trade.
export function setupShortlist(ranked,{pending=[],research={},at,limit=8}={}){
  const usable=new Map(ranked.map(r=>[r.symbol,r]));
  const reserved=[...pending.slice(0,2).map(s=>usable.get(s)).filter(Boolean),
    ...ranked.filter(r=>researchCohort(research[r.symbol],at)==='research-backed').slice(0,2)];
  const top=ranked.slice(0,Math.max(0,limit-2));
  const pool=ranked.filter(r=>![...reserved,...top].some(x=>x.symbol===r.symbol));
  const start=pool.length?(Math.floor(at.getTime()/STEP)*2)%pool.length:0;
  const rotate=pool.length?[pool[start],pool[(start+1)%pool.length]]:[];
  return [...new Map([...reserved,...rotate,...top,...ranked].map(r=>[r.symbol,r])).values()].slice(0,limit)
    .sort((a,b)=>(b.discoveryScore??0)-(a.discoveryScore??0));
}
