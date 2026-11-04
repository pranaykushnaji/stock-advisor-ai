// Versioned paper experiment, deliberately separate from the archived executed-trade model.
// No broker order APIs. A single JSON state holds cash, positions and closed trades atomically.
import { quoteFreshness, benchmarkObservation } from './_upstox-market-data.js';
import { rankByDiscoveryScore } from './_discovery-score.js';
import { ema } from './_indicators.js';
import { liveSimulationEntry } from './_entry-research.js';
import { researchExitObservation } from '../research/paper-plan.js';
import { tradingSessionsHeld } from './_position-risk.js';

export const SIM_CONFIG = Object.freeze({ version: 'paper-breakout-v1', dailyInvestment: 10000,
  executionRuleVersion:'five-minute-opening-v2',
  maxPositionInvestment: 5000, maxBuysPerDay: 3, maxOpenPositions: 5,
  modeledRiskPerTrade: 100, maxModeledOpenRisk: 500,
  maxSpreadBps: 30, minimumAverageTurnoverCr: 10,
  minStopPct: 0.5, maxStopPct: 3, entrySlippageBps: 5, exitSlippageBps: 5,
  costBpsPerSide: 15, noProgressSessions: 3, maximumSessions: 5,
});
const round = n => Math.round(n * 100) / 100;
const ymd = d => new Date(d.getTime() + 19800000).toISOString().slice(0, 10);
const freshQuote = (q, member, at) => q?.symbol === member.symbol && q?.instrumentKey === member.instrumentKey
  && quoteFreshness(q, { nowMs: at.getTime() }).fresh;
export function emptySimulation() {
  return { version: 1, strategyVersion: SIM_CONFIG.version, mode: 'experimental-paper-only', cash: 0,
    contributions: 0, positions: [], trades: [], days: {}, lastSlots: {}, dailyCache: {}, suggestions: [] };
}
export function validateSimulation(s) {
  if (!s || s.version !== 1 || s.strategyVersion !== SIM_CONFIG.version || s.mode !== 'experimental-paper-only'
    || !Number.isFinite(s.cash) || s.cash < 0 || !Number.isFinite(s.contributions) || s.contributions < 0
    || !Array.isArray(s.positions) || !Array.isArray(s.trades) || !s.days || !s.lastSlots || !s.dailyCache
    || !Array.isArray(s.suggestions)) throw new Error('Invalid simulation ledger; refusing to overwrite');
  if (s.positions.some(p => !Number.isInteger(p.shares) || p.shares < 1 || !(p.entryPrice > 0) || !(p.initialStopPrice > 0)
    || !p.id || !p.instrumentKey || !p.symbol || !p.date || !(p.investedAmount > 0)
    || !Number.isFinite(p.modeledInitialRisk) || !Number.isFinite(p.entryCost))) throw new Error('Invalid paper position');
  if(new Set(s.positions.map(p=>p.id)).size!==s.positions.length||new Set(s.trades.map(p=>p.id)).size!==s.trades.length)throw new Error('Duplicate simulation ledger identity');
  return s;
}
export function dailyReference(candles, date) {
  const rows = (candles || []).map(r => ({date:String(r[0]).slice(0,10),close:r[4],volume:r[5]}))
    .filter(r => r.date < date && Number.isFinite(r.close) && r.close > 0 && Number.isFinite(r.volume) && r.volume >= 0)
    .sort((a,b)=>a.date.localeCompare(b.date));
  const unique = [...new Map(rows.map(r=>[r.date,r])).values()];
  if (unique.length < 21) return null;
  const last = unique.slice(-20);
  return { asOf:date, lastSession:unique.at(-1).date, sessions:unique.length,
    ema20:ema(unique.map(r=>r.close),20),
    averageTurnoverCr:last.reduce((s,r)=>s+r.close*r.volume,0)/20/1e7 };
}

export function rankSimulationUniverse(members, quotes, {at, surveillance = [], negativeSymbols = [], blocked = [], researchBySymbol = {}} = {}) {
  const reject = [], rows = [], membersBySymbol = new Map(members.map(m=>[m.symbol,m]));
  const excluded = new Set([...surveillance,...negativeSymbols,...blocked]);
  for (const m of members) {
    if (!['mid','small'].includes(m.marketCapBucket) || !m.instrumentKey || excluded.has(m.symbol)) continue;
    const q = quotes[m.instrumentKey];
    if (!freshQuote(q,m,at)) {reject.push({ticker:m.symbol,reasons:['missing or stale instrument quote']});continue;}
    const reasons = [];
    if (!(q.price >= 20)) reasons.push('price below ₹20');
    if (!Number.isFinite(q.spreadBps) || q.spreadBps > SIM_CONFIG.maxSpreadBps || !(q.askPrice >= q.bidPrice) || !(q.bidPrice > 0)) reasons.push('missing or wide bid/ask spread');
    if (!(q.upperCircuit > q.price && q.lowerCircuit < q.price)) reasons.push('official circuit bands unavailable or reached');
    else if (q.price >= q.upperCircuit*0.995 || q.price <= q.lowerCircuit*1.005) reasons.push('too close to official circuit');
    if (!(q.previousClose > 0) || !(q.dayHigh > q.dayLow) || !(q.volume > 0)) reasons.push('incomplete session data');
    const change = q.previousClose > 0 ? (q.price/q.previousClose-1)*100 : null;
    if (change == null || change <= 0 || change >= 8) reasons.push('weak or overextended session move');
    if (reasons.length) { reject.push({ticker:m.symbol,reasons});continue; }
    rows.push({symbol:m.symbol,pChange:change,lastPrice:q.price,dayHigh:q.dayHigh,dayLow:q.dayLow,totalTradedVolume:q.volume});
  }
  const sectors = new Map();
  // Include declining peers too; selecting only positive candidates would fabricate sector strength.
  for(const member of members){const q=quotes[member.instrumentKey];if(!freshQuote(q,member,at)||!(q.previousClose>0))continue;
    const a=sectors.get(member.sector)||[];a.push((q.price/q.previousClose-1)*100);sectors.set(member.sector,a);}
  const ranked=rankByDiscoveryScore(rows,r=>{
    const peers=sectors.get(membersBySymbol.get(r.symbol).sector)||[];
    return {sectorScore:peers.length>=3?Math.min(100,50+peers.reduce((s,n)=>s+n,0)/peers.length*10):50,
      hasCatalyst:researchBySymbol[r.symbol]?.verified===true};
  });
  return {ranked,rejected:reject};
}

export function transitionSimulation(input, market, {at, action='risk', config=SIM_CONFIG} = {}) {
  validateSimulation(input);
  const s=structuredClone(input),date=ymd(at),slot=Math.floor(at.getTime()/300000)*300000;
  if (!['risk','scan','research'].includes(action)) throw new Error('Invalid simulation action');
  if (slot <= (s.lastSlots[action] || 0)) return {state:s,status:'duplicate',changed:false};
  // Decisions older than a committed observation must never execute backwards in time.
  if (at.getTime() < (Date.parse(s.updatedAt)||0)) return {state:s,status:'out_of_order',changed:false};
  if(action==='research'){
    const blocked=new Set(s.positions.map(p=>p.ticker));
    s.suggestions=(market.candidates||[]).filter(c=>!blocked.has(c.symbol)).map(c=>({
      ticker:c.symbol,fullName:c.name,sector:c.sector,discoveryScore:null,price:null,observedAt:null,
      research:market.researchBySymbol?.[c.symbol]??null,status:market.researchBySymbol?.[c.symbol]?.negative?'not-qualified':'watch',
      reasons:[market.researchBySymbol?.[c.symbol]?.negative
        ?'verified negative event: excluded from entries'
        :'premarket research only; awaiting fresh market data and a completed breakout']}));
    s.lastSlots.research=slot;s.updatedAt=at.toISOString();s.config=config;
    s.lastCheck={at:s.updatedAt,action,bought:null,checked:[]};
    validateSimulation(s);
    return {state:s,status:'researched',changed:true,bought:null,checked:[]};
  }
  if (!s.days[date]) {
    s.days[date]={contribution:config.dailyInvestment,invested:0,buys:[],exits:[]};
    s.cash=round(s.cash+config.dailyInvestment);s.contributions=round(s.contributions+config.dailyInvestment);
  }
  const day=s.days[date],checked=[],exits=[];
  const negatives=new Set(market.negativeSymbols||[]);
  for(const p of s.positions){
    const q=market.quotes[p.instrumentKey];
    if(!freshQuote(q,p,at) || !(q.bidPrice>0)) {checked.push({ticker:p.ticker,status:'unusable_price'});continue;}
    const result=researchExitObservation(p,q,{nowMs:at.getTime()});
    if(result.status==='unavailable'||Date.parse(q.lastTradeAt)<(Date.parse(p.lastObservedAt)||0)){checked.push({ticker:p.ticker,status:result.status});continue;}
    Object.assign(p,result.state,{currentPrice:q.price,lastPriceUpdate:q.lastTradeAt});
    const held=tradingSessionsHeld(p.date,at),risk=p.entryPrice-p.initialStopPrice;
    let decision=result.decision;
    if(!decision && negatives.has(p.ticker)) decision={reason:'verified negative event invalidates setup',observedFillPrice:q.bidPrice};
    if(!decision && held>=config.maximumSessions) decision={reason:'experimental five-session horizon',observedFillPrice:q.bidPrice};
    if(!decision && held>=config.noProgressSessions && q.price-p.entryPrice<risk*0.5) decision={reason:'setup failed to make progress after three sessions',observedFillPrice:q.bidPrice};
    if(!decision){checked.push({ticker:p.ticker,status:'hold'});continue;}
    const fill=Math.min(decision.observedFillPrice,q.bidPrice)*(1-config.exitSlippageBps/10000);
    const proceeds=round(fill*p.shares),exitCost=round(proceeds*config.costBpsPerSide/10000);
    const gross=round((fill-p.entryPrice)*p.shares),net=round(gross-p.entryCost-exitCost);
    const trade={...p,entryAt:p.addedAt,entryDate:p.date,exitAt:q.lastTradeAt,exitDate:date,exitPrice:fill,
      triggerPrice:decision.triggerPrice??null,exitReason:decision.reason,realizedPnl:gross,realizedNetPnl:net,
      realizedPnlPct:round((fill/p.entryPrice-1)*100),entryCost:p.entryCost,exitCost,
      estimatedCostAmount:round(p.entryCost+exitCost),executionModel:'observed-bid-plus-slippage-paper-only'};
    s.trades.push(trade);s.cash=round(s.cash+proceeds-exitCost);day.exits.push(p.ticker);exits.push(p.id);
    checked.push({ticker:p.ticker,status:'sold',reason:trade.exitReason,netPnl:net});
  }
  s.positions=s.positions.filter(p=>!exits.includes(p.id));
  let bought=null;
  if(action==='scan'){
    s.suggestions=(market.candidates||[]).map(c=>({ticker:c.symbol,fullName:c.name,sector:c.sector,
      discoveryScore:c.discoveryScore??null,price:market.quotes[c.instrumentKey]?.price??null,
      observedAt:market.quotes[c.instrumentKey]?.lastTradeAt??null,
      research:market.researchBySymbol?.[c.symbol]??null,reasons:[],status:'watch'}));
    const blocked=new Set([...s.positions.map(p=>p.ticker),...day.buys,...day.exits]);
    const benchmark=market.quotes['NSE_INDEX|Nifty 50'];
    const benchmarkState=benchmarkObservation(benchmark,{nowMs:at.getTime()});
    const benchmarkFresh=benchmarkState.fresh,benchChange=benchmarkState.changePct;
    market.discovery={...(market.discovery||{}),benchmark:benchmarkState};
    for(const c of market.candidates||[]){
      const row=s.suggestions.find(r=>r.ticker===c.symbol),reasons=row.reasons;
      const q=market.quotes[c.instrumentKey],reference=market.references?.[c.symbol];
      const setup=freshQuote(q,c,at)?liveSimulationEntry(market.candles?.[c.symbol]||[],q,{now:at,regime:'neutral'}):null;
      row.entryDiagnostics=setup?{status:setup.status,reason:setup.reason??null,version:setup.setupVersion??null}:null;
      if(setup?.status==='setup')row.setup=setup;
      if(blocked.has(c.symbol))reasons.push('held or traded today');
      if(day.buys.length>=config.maxBuysPerDay)reasons.push('three daily positions already opened');
      if(s.positions.length>=config.maxOpenPositions)reasons.push('five-position exposure cap');
      if(!market.safetyReady)reasons.push('current surveillance/event safety context unavailable');
      if(!benchmarkFresh||benchChange==null)reasons.push('benchmark price unavailable');
      else if(benchChange < -1)reasons.push('benchmark down more than 1%: experimental risk-off');
      if(!freshQuote(q,c,at))reasons.push('missing or stale execution quote');
      else if(!Number.isFinite(q.spreadBps)||q.spreadBps>config.maxSpreadBps||!(q.askPrice>=q.bidPrice)||!(q.bidPrice>0))reasons.push('missing or wide execution spread');
      if(negatives.has(c.symbol))reasons.push('verified negative catalyst');
      if(!reference || reference.asOf!==date || reference.averageTurnoverCr<config.minimumAverageTurnoverCr)reasons.push('20-session average turnover below ₹10Cr or missing');
      if(!Number.isFinite(reference?.ema20))reasons.push('20-session EMA unavailable');
      else if(q?.price<=reference.ema20)reasons.push('below 20-session EMA');
      if(benchChange!=null&&q?.previousClose>0&&(q.price/q.previousClose-1)*100<=benchChange)reasons.push('not outperforming Nifty');
      if(s.positions.some(p=>p.sector===c.sector))reasons.push('sector already represented');
      if(setup?.status!=='setup')reasons.push(setup?.reason||'no usable completed breakout evidence');
      if(reasons.length)continue;
      if(!(q.upperCircuit>q.price && q.lowerCircuit<q.price) || q.price>=q.upperCircuit*0.995 || q.price<=q.lowerCircuit*1.005){reasons.push('official circuit limit unavailable or too close at execution');continue;}
      const fill=q.askPrice*(1+config.entrySlippageBps/10000),stop=setup.supportLevel*0.999;
      const stopPct=(1-stop/fill)*100;
      if(stopPct<config.minStopPct||stopPct>config.maxStopPct){reasons.push('structure stop outside experimental 0.5–3% band');continue;}
      const openRisk=s.positions.reduce((total,p)=>total+p.modeledInitialRisk,0);
      const riskCash=Math.min(config.modeledRiskPerTrade,config.maxModeledOpenRisk-openRisk);
      const lossPerShare=fill-stop+fill*(config.costBpsPerSide*2+config.exitSlippageBps)/10000;
      const remaining=Math.max(0,config.dailyInvestment-day.invested);
      const amount=Math.min(config.maxPositionInvestment,remaining,s.cash);
      const shares=Math.floor(Math.min(amount/(fill*(1+config.costBpsPerSide/10000)),riskCash/lossPerShare));
      if(shares<1){reasons.push('remaining capital or modeled risk cannot fund a whole share');continue;}
      const invested=round(shares*fill),entryCost=round(invested*config.costBpsPerSide/10000);
      if(invested+entryCost>remaining||invested+entryCost>s.cash){reasons.push('capital limit after cost rounding');continue;}
      const p={id:`${date}|${c.symbol}|${config.version}`,ticker:c.symbol,symbol:c.symbol,instrumentKey:c.instrumentKey,
        fullName:c.name,sector:c.sector,date,addedAt:q.lastTradeAt,strategyVersion:config.version,entryLane:'experimental-consolidation',
        entryPrice:fill,shares,investedAmount:invested,entryCost,initialStopPrice:stop,initialStopPct:stopPct,
        modeledInitialRisk:round(shares*lossPerShare),peakPrice:fill,currentPrice:q.price,lastObservedAt:q.lastTradeAt,lastPriceUpdate:q.lastTradeAt,
        summary:setup.setupVersion==='opening-consolidation-v1'
          ?'Completed opening-range breakout with at least 2x recent-bar volume; above VWAP and EMA20, positive relative strength.'
          :'Confirmed completed 30-minute consolidation breakout, volume expansion, above session VWAP and 20-session EMA; positive relative strength.',
        setup,research:market.researchBySymbol?.[c.symbol]??null,executionRuleVersion:config.executionRuleVersion,
        quoteTimestamp:q.lastTradeAt,paperTrading:true,expectedEdge:null};
      s.positions.push(p);s.cash=round(s.cash-invested-entryCost);day.invested=round(day.invested+invested+entryCost);day.buys.push(c.symbol);
      row.status='simulated-buy';row.setup=setup;row.reasons=['confirmed setup; simulated fill recorded'];bought=c.symbol;break;
    }
    for(const row of s.suggestions){if(row.status!=='simulated-buy')row.status=row.reasons.length?'not-qualified':'not-selected';}
    s.discovery=market.discovery||null;
  }
  s.lastSlots[action]=slot;s.updatedAt=at.toISOString();s.config=config;
  s.lastCheck={at:s.updatedAt,action,bought,checked,entryPause:market.entryPause??null,
    researchStatus:market.researchUnavailable?'unavailable':'loaded'};
  validateSimulation(s);
  return {state:s,status:checked.some(r=>r.status==='unusable_price')?'partial':'processed',changed:true,bought,checked};
}
