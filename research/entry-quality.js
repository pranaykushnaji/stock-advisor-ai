// Shared by paper execution and isolated replay. Thresholds are hypotheses, not
// calibrated probabilities. Never uses unfinished candles or future observations.
import {completedFiveMinuteBars, liveSimulationEntry} from '../api/_entry-research.js';
import {benchmarkObservation} from '../api/_upstox-market-data.js';
import {candleIntegrity} from './candle-integrity.js';

export const ENTRY_QUALITY = Object.freeze({version:'intraday-confirmation-v1',
  marketDrop5Pct:-0.15,marketDrop15Pct:-0.25,marketQuoteDropPct:-0.10,
  maxVwapPremiumPct:1.5,maxRise15Pct:2.5,maxBreakoutPremiumPct:0.75,
  maxRangeMultiples:2,maxSignalAgeBars:3,retestTolerancePct:0.2,
  minimumCloseLocation:0.65,maxPrior5ReturnPct:12,maxEma20PremiumPct:6});
export const ENTRY_VARIANTS = Object.freeze(['baseline','follow-through','retest','adaptive']);
const STEP=300000, pct=(a,b)=>(a/b-1)*100;
const mean=a=>a.reduce((s,n)=>s+n,0)/a.length;
function ema(values,period=5){const k=2/(Math.min(period,values.length)+1);return values.reduce((e,v,i)=>i?v*k+e*(1-k):v,0);}
function frame(candles,now){
  const integrity=candleIntegrity(candles,{nowMs:now.getTime(),date:new Date(now.getTime()+19800000).toISOString().slice(0,10)});
  if(integrity.issues.length)return {status:'unavailable',reason:integrity.issues.join('; '),dataQuality:{issues:integrity.issues}};
  const boundary=Math.floor(now.getTime()/STEP)*STEP,bars=completedFiveMinuteBars(Array.isArray(candles)?candles:[],now);
  if(!bars.length||bars.at(-1).ms+STEP!==boundary)return {status:'unavailable',reason:'latest completed five-minute history missing'};
  // A gap in the most recent fifteen minutes is never silently bridged.
  const last=bars.slice(-3);
  if(last.length<3||last.some((b,i)=>i&&b.ms-last[i-1].ms!==STEP))return {status:'unavailable',reason:'three contiguous completed five-minute candles required'};
  const end=bars.at(-1),closeAt=t=>bars.find(b=>b.ms+STEP===t)?.close;
  const start=Date.parse(`${new Date(boundary+19800000).toISOString().slice(0,10)}T09:15:00+05:30`);
  if(bars[0].ms!==start||bars.some((b,i)=>i&&b.ms-bars[i-1].ms!==STEP))
    return {status:'unavailable',reason:'complete session candle history required for momentum and VWAP'};
  const basis=minutes=>boundary-minutes*60000===start?bars.find(b=>b.ms===start)?.open:closeAt(boundary-minutes*60000);
  const r=minutes=>basis(minutes)>0?pct(end.close,basis(minutes)):null;
  let volume=0,pv=0;
  for(const b of bars){volume+=b.volume;pv+=(b.high+b.low+b.close)/3*b.volume;}
  const preceding=bars.slice(-7,-1);
  return {status:'ready',bars,boundary,close:end.close,return5Pct:r(5),return15Pct:r(15),return30Pct:r(30),
    ema5:ema(bars.map(b=>b.close)),vwap:volume>0?pv/volume:null,
    typicalRangePct:preceding.length?mean(preceding.map(b=>pct(b.high,b.low))):null,
    lastRangePct:pct(end.high,end.low),lastBarAt:new Date(end.ms+STEP).toISOString()};
}

export function entryMarketContext(candles,quote,{now=new Date(),params=ENTRY_QUALITY}={}){
  const snapshot=benchmarkObservation(quote,{nowMs:now.getTime()}),f=frame(candles,now),reasons=[];
  if(!snapshot.fresh)reasons.push('fresh Nifty provider snapshot required');
  if(f.status!=='ready')reasons.push(`Nifty momentum unavailable: ${f.reason}`);
  if(f.status==='ready'){
    if(f.return15Pct==null)reasons.push('Nifty fifteen-minute baseline missing');
    if(f.return5Pct<=params.marketDrop5Pct)reasons.push('Nifty falling sharply over five minutes');
    if(f.return15Pct<=params.marketDrop15Pct)reasons.push('Nifty falling sharply over fifteen minutes');
    if(f.return15Pct<0&&f.close<f.ema5)reasons.push('Nifty recent trend deteriorating below short EMA');
    if(snapshot.fresh&&pct(quote.price,f.close)<=params.marketQuoteDropPct)reasons.push('Nifty dropping after latest completed candle');
  }
  if(snapshot.fresh&&snapshot.changePct< -1)reasons.push('Nifty daily risk-off');
  return {version:params.version,at:now.toISOString(),status:reasons.length?'blocked':'supportive',reasons,
    metrics:{return5Pct:f.return5Pct??null,return15Pct:f.return15Pct??null,return30Pct:f.return30Pct??null,
      close:f.close??null,ema5:f.ema5??null,lastBarAt:f.lastBarAt??null,dayChangePct:snapshot.changePct},
    source:'completed provider candles + timestamped index snapshot'};
}

// Confirmation is always AFTER the original breakout. An apparent retest inside
// the original breakout candle is not counted; OHLC cannot establish its path.
function confirmedSetup(candles,quote,now,mode,params){
  const bars=completedFiveMinuteBars(Array.isArray(candles)?candles:[],now),boundary=Math.floor(now.getTime()/STEP)*STEP;
  if(!bars.length||bars.at(-1).ms+STEP!==boundary||now.getTime()-boundary>90000)
    return {status:'unavailable',reason:'fresh completed confirmation candle required'};
  const quoteMs=Date.parse(quote?.lastTradeAt);
  if(!Number.isFinite(quoteMs)||quoteMs<boundary||quoteMs>now.getTime())return {status:'unavailable',reason:'execution quote must follow completed confirmation'};
  for(let age=1;age<=params.maxSignalAgeBars;age++){
    const signalEnd=boundary-age*STEP,after=bars.filter(b=>b.ms>=signalEnd);
    if(after.length!==age||after.some((b,i)=>b.ms!==signalEnd+i*STEP))continue;
    const original=liveSimulationEntry(candles,{price:after[0].open,lastTradeAt:new Date(signalEnd).toISOString()},
      {now:new Date(signalEnd+1),regime:'neutral'});
    if(original.status!=='setup')continue;
    const breakout=bars.find(b=>b.ms+STEP===signalEnd),level=original.breakoutLevel,end=after.at(-1);
    const held=after.every(b=>b.close>=level&&b.low>=level*(1-params.retestTolerancePct/100));
    const strongClose=end.high>end.low&&(end.close-end.low)/(end.high-end.low)>=params.minimumCloseLocation&&end.close>end.open;
    const retested=after.some(b=>b.low<=level*(1+params.retestTolerancePct/100));
    const follow=age===1&&end.close>=breakout.close;
    if(!held||!strongClose||quote.price<level||quote.price<end.close*0.9995)continue;
    const kind=retested?'retest':follow?'follow-through':null;
    if(!kind||(mode==='retest'&&!retested)||(mode==='follow-through'&&!follow))continue;
    if(pct(quote.price,level)>params.maxBreakoutPremiumPct)continue;
    return {...original,entryAt:quote.lastTradeAt,entryPrice:quote.price,confirmationType:mode==='follow-through'?'follow-through':kind,
      confirmationAt:new Date(boundary).toISOString(),signalAgeMinutes:age*5,execution:'observed-quote-paper-only'};
  }
  return {status:'no_setup',reason:mode==='retest'?'waiting for completed breakout retest and recovery':'waiting for completed breakout follow-through or retest'};
}

export function assessPaperEntry({candles,quote,reference,marketContext,now=new Date(),mode='adaptive',
  fillPrice=quote?.price,params=ENTRY_QUALITY}={}){
  if(!ENTRY_VARIANTS.includes(mode))throw Error('Unknown entry comparison variant');
  if(mode==='baseline')return {version:'baseline',status:'baseline',reasons:[],metrics:{},
    setup:liveSimulationEntry(candles,quote,{now,regime:'neutral'})};
  const f=frame(candles,now),reasons=[...(marketContext?.reasons||[])];
  if(!marketContext||marketContext.at!==now.toISOString())reasons.push('current scan market context required');
  if(f.status!=='ready')reasons.push(`stock momentum unavailable: ${f.reason}`);
  const m=marketContext?.metrics||{};
  const metrics={return5Pct:f.return5Pct??null,return15Pct:f.return15Pct??null,return30Pct:f.return30Pct??null,
    relative15Pct:f.return15Pct!=null&&m.return15Pct!=null?f.return15Pct-m.return15Pct:null,
    vwap:f.vwap??null,vwapPremiumPct:f.vwap>0?pct(fillPrice,f.vwap):null,
    ema5:f.ema5??null,typicalRangePct:f.typicalRangePct??null,
    prior5SessionReturnPct:reference?.return5Pct??null,ema20PremiumPct:reference?.ema20>0?pct(fillPrice,reference.ema20):null};
  if(f.status==='ready'){
    if(!(f.return5Pct>0)||!(f.return15Pct>0))reasons.push('stock recent five/fifteen-minute momentum not positive');
    if(!(metrics.relative15Pct>0))reasons.push('stock not outperforming Nifty over recent fifteen minutes');
    if(!(fillPrice>=f.ema5))reasons.push('stock below short intraday EMA');
    if(!(metrics.vwapPremiumPct>=0&&metrics.vwapPremiumPct<=params.maxVwapPremiumPct))reasons.push('execution price below VWAP or overextended above VWAP');
    if(f.return15Pct>params.maxRise15Pct)reasons.push('stock fifteen-minute move overextended');
    if(f.typicalRangePct>0&&f.lastRangePct>f.typicalRangePct*params.maxRangeMultiples)
      reasons.push('latest candle range abnormally expanded: do not chase');
  }
  if(reference?.version!==2||!Number.isFinite(reference?.return5Pct))reasons.push('prior-session stock movement reference unavailable');
  else if(reference.return5Pct>params.maxPrior5ReturnPct&&metrics.ema20PremiumPct>params.maxEma20PremiumPct)
    reasons.push('extended multi-session run far above EMA20');
  const setup=confirmedSetup(candles,quote,now,mode,params);
  const initial=liveSimulationEntry(Array.isArray(candles)?candles:[],quote,{now,regime:'neutral'});
  if(setup.status!=='setup')reasons.push(setup.reason);
  else if(!(fillPrice>0)||pct(fillPrice,setup.breakoutLevel)>params.maxBreakoutPremiumPct)
    reasons.push('executable ask plus slippage too far above breakout');
  return {version:params.version,mode,status:reasons.length?'blocked':'qualified',reasons:[...new Set(reasons)],metrics,setup,
    dataQuality:{issues:f.dataQuality?.issues||[]},
    pendingSignalAt:initial.status==='setup'?initial.signalAt:null};
}

export function researchCohort(research,at){
  const published=typeof research?.eventPublishedAt==='number'?research.eventPublishedAt:Date.parse(research?.eventPublishedAt);
  const age=at.getTime()-published;
  return research?.verified===true&&!research.negative&&Number.isFinite(age)&&age>=0&&age<=72*3600000
    ?'research-backed':'price-only';
}
