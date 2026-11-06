// Bounded, minified point-in-time input inside the existing atomic JSON ledger.
// Saving it as a JSON string avoids pretty-print multiplication of minute rows.
// Only explicitly selected market fields are retained; never environment/config.
const FIELDS=['symbol','instrumentKey','price','bidPrice','askPrice','spreadBps','upperCircuit','lowerCircuit',
  'dayHigh','dayLow','previousClose','volume','averagePrice','lastTradeAt','responseAt'];
export function captureEntryEvidence(market,at,{maxCharacters=450000}={}){
  const quotes=Object.fromEntries(Object.entries(market.quotes||{}).map(([key,q])=>[key,
    Object.fromEntries(FIELDS.filter(f=>q?.[f]!==undefined).map(f=>[f,q[f]]))]));
  const frame={quotes,candidates:market.candidates||[],references:market.references||{},candles:market.candles||{},
    benchmarkCandles:market.benchmarkCandles||[],researchBySymbol:market.researchBySymbol||{},
    negativeSymbols:market.negativeSymbols||[],safetyReady:market.safetyReady===true};
  const payload=JSON.stringify(frame);
  if(new TextEncoder().encode(payload).byteLength>maxCharacters)return {version:1,at:at.toISOString(),status:'omitted',reason:'input exceeded bounded evidence budget'};
  return {version:1,at:at.toISOString(),status:'recorded',encoding:'json',source:'point-in-time provider inputs',payload};
}
export function readEntryEvidence(evidence){
  if(evidence?.version!==1||evidence.status!=='recorded'||evidence.encoding!=='json'||typeof evidence.payload!=='string')return null;
  try{const frame=JSON.parse(evidence.payload);return frame&&Array.isArray(frame.candidates)&&frame.quotes?frame:null;}catch{return null;}
}
