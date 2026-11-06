// One portable evidence schema for the engine, read-only UI and research reports.
// Availability is NOT qualification; a present but weak metric can still reject.
const finite=n=>typeof n==='number'&&Number.isFinite(n),pos=n=>finite(n)&&n>0;
const ratio=(a,b)=>pos(a)&&pos(b)?(a/b-1)*100:null;
export function decisionEvidence({quote,reference,setup,assessment,marketContext,benchmark,at,
  slippageBps=5,requireMomentum=false,requireAtr=false,safetyReady=false,
  quoteSource='Upstox',dailySource='Upstox',candleSource='Completed five-minute candles',benchmarkSource='Upstox'}={}){
  const asOf=at.toISOString(),metrics={};
  function add(key,label,value,unit,source,measuredAt,required=false,reason='not supplied by the decision input'){
    const available=typeof value==='boolean'||finite(value);
    const time=Date.parse(measuredAt),dated=Number.isFinite(time)&&time<=at.getTime();
    const domain=available&&(unit==='INR'||unit==='₹ Cr'?value>0:unit==='bp'||unit==='×'||unit==='s'?value>=0:unit==='/100'?value>=0&&value<=100:true)
      &&(key!=='atr14Pct'||value>0);
    const valid=available&&dated&&domain,given=value!==null&&value!==undefined;
    metrics[key]={label,value:valid?value:null,unit,source,asOf:measuredAt??null,required,
      status:valid?'available':given&&(!available||!domain)?'invalid':'missing',
      reason:valid?null:given&&(!available||!domain)?'source value has an invalid type or numeric range':!dated?'original observation timestamp missing or future':reason};
  }
  const t=quote?.lastTradeAt,day=reference?.lastSession?`${reference.lastSession}T15:30:00+05:30`:reference?.asOf?`${reference.asOf}T00:00:00+05:30`:null;
  const signal=setup?.signalAt??asOf,fill=pos(quote?.askPrice)?quote.askPrice*(1+slippageBps/10000):null;
  const stop=pos(setup?.supportLevel)?setup.supportLevel*.999:null;
  add('executionPrice','Modeled entry ask + slippage',fill,'INR',quoteSource+' order book',t,true);
  add('bidPrice','Observed best bid',quote?.bidPrice,'INR',quoteSource+' order book',t,true);
  add('askPrice','Observed best ask',quote?.askPrice,'INR',quoteSource+' order book',t,true);
  add('spreadBps','Bid/ask spread',quote?.spreadBps,'bp',quoteSource+' order book',t,true);
  const age=(at.getTime()-Date.parse(t))/1000;
  add('quoteAgeSeconds','Execution quote age',age>=0?age:null,'s',quoteSource+' last trade timestamp',asOf,true);
  add('ema20','20-session EMA',reference?.ema20,'INR',dailySource+' prior daily closes',day,true);
  add('averageTurnoverCr','20-session average traded value',reference?.averageTurnoverCr,'₹ Cr',dailySource+' prior daily close × volume',day,true);
  add('vwap','Signal session VWAP',setup?.vwap??assessment?.metrics?.vwap,'INR',candleSource+' (typical-price approximation)',signal,true);
  add('breakoutLevel',setup?.setupType==='trend-pullback'?'Pullback recovery trigger':'Consolidation breakout level',setup?.breakoutLevel,'INR',candleSource+' pre-signal structure',signal,true);
  add('initialStop','Initial structural stop',stop,'INR','Range support × 0.999',signal,true);
  add('breakoutVolumeRatio',setup?.setupType==='trend-pullback'?'Recovery volume / pullback-bar average':'Breakout volume / preceding range average',setup?.volumeRatio,'×',candleSource,signal,true);
  add('stockDayReturnPct','Stock change since previous close',ratio(quote?.price,quote?.previousClose),'%',quoteSource+' quote',t,true);
  add('niftyDayReturnPct','Nifty change since previous close',ratio(benchmark?.price,benchmark?.previousClose),'%',benchmarkSource+' index snapshot',benchmark?.responseAt,true);
  add('safetyReady','Surveillance / event context loaded',safetyReady===true,'boolean','NSE snapshot + saved event checks',asOf,true);
  for(const [key,label,value] of [
    ['stock5Pct','Stock: recent 5 minutes',assessment?.metrics?.return5Pct],
    ['stock15Pct','Stock: recent 15 minutes',assessment?.metrics?.return15Pct],
    ['relative15Pct','Stock minus Nifty: recent 15 minutes',assessment?.metrics?.relative15Pct],
    ['nifty5Pct','Nifty: recent 5 minutes',marketContext?.metrics?.return5Pct],
    ['nifty15Pct','Nifty: recent 15 minutes',marketContext?.metrics?.return15Pct],
    ['prior5Pct','Stock: prior 5 completed sessions',reference?.return5Pct]])
    add(key,label,value,'%',key==='prior5Pct'?dailySource+' completed daily history':candleSource,key==='prior5Pct'?day:asOf,requireMomentum);
  add('sessionVolumeRatio','Volume so far / average FULL-day volume',pos(reference?.averageVolume)?quote?.volume/reference.averageVolume:null,
    '×',quoteSource+' session volume / '+dailySource+' prior 20 daily volumes',t,false,'20-session volume baseline unavailable; this is not time-normalized RVOL');
  add('rsi14','Daily RSI (14)',reference?.rsi14,'/100',dailySource+' prior daily closes; Wilder smoothing',day,false,'fifteen completed daily closes required');
  add('atr14Pct','Daily ATR (14)',reference?.atr14Pct,'%',dailySource+' prior daily OHLC',day,requireAtr,'fifteen valid daily OHLC candles required');
  add('ema50','50-session EMA',reference?.ema50,'INR',dailySource+' prior daily closes',day,false,'fifty completed daily closes required');
  add('exchangeAverage','Exchange average traded price',quote?.averagePrice,'INR',quoteSource+' average_price; separate from the computed signal VWAP',t,false,
    'exchange average_price not supplied; computed VWAP is recorded separately');
  const required=Object.entries(metrics).filter(([,m])=>m.required),missing=required.filter(([,m])=>m.status!=='available').map(([k])=>k);
  const invalid=[...new Set([...(reference?.dataQuality?.issues||[]),...(assessment?.dataQuality?.issues||[])])];
  return {version:1,asOf,scope:'decision-time inputs; not current live metrics',metrics,
    readiness:{ready:missing.length===0&&invalid.length===0,requiredTotal:required.length,
      requiredAvailable:required.length-missing.length,missingRequired:missing,invalidInputs:invalid},
    notUsed:['LLM confidence / win probability','Institutional ownership or delivery percentage','Legacy composite / flow score']};
}
