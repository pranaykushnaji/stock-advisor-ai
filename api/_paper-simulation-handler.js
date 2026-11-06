import { requireCronAuth } from './_cron-auth.js';
import { marketStatus, nowIST } from './_market-calendar.js';
import { fetchFullQuotes, fetchIntradayOneMinuteCandles, fetchDailyCandles } from './_upstox-market-data.js';
import { quoteBatches } from '../research/coverage.js';
import registry from '../research/universe.json' with {type:'json'};
import { rankSimulationUniverse, transitionSimulation, validateSimulation, dailyReference, SIM_CONFIG } from './_paper-simulation.js';
import { savedResearchContext } from './_paper-research-context.js';

const FILE='data/paper-simulation.json',REPO='pranaykushnaji/stock-advisor-ai';
async function readFile(path,env) {
  const r=await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=main`,{
    headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw Error('simulation context unavailable');
  const d=await r.json();return {data:JSON.parse(Buffer.from(d.content,'base64').toString('utf8')),sha:d.sha};
}
async function writeFile(state,sha,env) {
  const r=await fetch(`https://api.github.com/repos/${REPO}/contents/${FILE}`,{method:'PUT',
    headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},
    body:JSON.stringify({branch:'main',sha,message:`Paper simulation ${state.lastCheck.action} ${state.updatedAt} [skip ci]`,
      content:Buffer.from(JSON.stringify(state,null,2)).toString('base64')}),signal:AbortSignal.timeout(10000)});
  if(r.status===409||r.status===422)return false;
  if(!r.ok)throw Error('simulation write failed');return true;
}
async function loadSafety(env,at,members) {
  const optional=path=>readFile(path,env).then(r=>r.data).catch(()=>({}));
  const [snap,mem,watchlist,intel]=await Promise.all([readFile('data/nse-snapshot.json',env),
    optional('data/catalyst-memory.json'),optional('data/premarket-watchlist.json'),optional('data/news-intel.json')]);
  const ms=Date.parse(snap.data.fetchedAt),age=at.getTime()-ms;
  const safetyReady=Number.isFinite(ms)&&age>=0&&age<=4*3600000&&snap.data.diag?.surveillance===true&&Array.isArray(snap.data.data?.surveillance);
  const research=savedResearchContext({watchlist,intel,memory:mem},at,members);
  const negativeSymbols=[...research.negativeSymbols];
  // Official-subject risk flags are conservative review exclusions, not an LLM claim
  // that a crime occurred. Full filing interpretation remains a separate research task.
  for(const a of snap.data.data?.announcements||[]){
    if(/fraud|insolvency|bankrupt|order cancellation|default on|sebi.*(penalty|action)|investigation/i.test(a.subject||''))negativeSymbols.push(a.symbol);
  }
  return {...research,safetyReady,surveillance:snap.data.data?.surveillance||[],negativeSymbols};
}

export function createSimulationHandler({env=process.env,now=()=>new Date(),read=path=>readFile(path,env),
  write=(state,sha)=>writeFile(state,sha,env),quotes=fetchFullQuotes,intraday=fetchIntradayOneMinuteCandles,
  daily=fetchDailyCandles,members=registry.members,registryFetchedAt=registry.fetchedAt,safety=at=>loadSafety(env,at,members),config=SIM_CONFIG}={}){
  return async(req,res)=>{
    res.setHeader?.('Cache-Control','no-store');
    if(!requireCronAuth(req,res))return;
    if(req.method!=='POST')return res.status(405).json({error:'POST required'});
    if(env.PAPER_SIMULATION_ENABLED!=='true')return res.status(200).json({status:'disabled',paperTrading:true});
    if(!env.UPSTOX_ACCESS_TOKEN||!env.GITHUB_TOKEN)return res.status(503).json({status:'not_configured'});
    let body=req.body||{};
    try{if(typeof body==='string')body=JSON.parse(body);}catch{return res.status(400).json({error:'invalid JSON'});}
    if(!body||typeof body!=='object'||Array.isArray(body))return res.status(400).json({error:'invalid payload'});
    let at=now();
    let action=req.query?.action||'risk';
    if(!['risk','scan','research'].includes(action))return res.status(400).json({error:'unknown simulation action'});
    try{
      const initial=await read(FILE);validateSimulation(initial.data);
      if(body.mode==='health'){
        const sample=members.filter(m=>m.instrumentKey).slice(0,1);
        const q={};
        const checkedMembers=body.testCoverage===true?members.filter(m=>['mid','small'].includes(m.marketCapBucket)&&m.instrumentKey):sample;
        for(const batch of quoteBatches(checkedMembers))Object.assign(q,await quotes(batch));
        let candleAccess=null;
        if(body.testCandles===true){
          const date=nowIST(at).ymd,from=new Date(at.getTime()-100*86400000).toISOString().slice(0,10);
          const [h,i]=await Promise.all([daily(sample[0].instrumentKey,from,date),intraday(sample[0].instrumentKey)]);
          candleAccess={historicalDaily:h.length,intradayMinutes:i.length};
        }
        return res.status(200).json({status:'ready',mode:'experimental-paper-only',dailyInvestment:config.dailyInvestment,
          fundingMode:config.fundingMode,sharesPerEntry:config.sharesPerEntry,maxBuysPerDay:config.maxBuysPerDay,
          maxOpenPositions:config.maxOpenPositions,sectorLimit:config.sectorLimit,
          entryMode:config.entryMode??'baseline',executionRuleVersion:config.executionRuleVersion,entryQualityVersion:config.entryQualityVersion??null,
          positions:initial.data.positions.length,trades:initial.data.trades.length,
          registryMapped:members.filter(m=>m.instrumentKey).length,quotesRequested:checkedMembers.length,quotesReceived:Object.keys(q).length,candleAccess,
          marketOpen:marketStatus(at).open&&at.getTime()>=Date.parse(`${nowIST(at).ymd}T09:15:00+05:30`)
            &&at.getTime()<Date.parse(`${nowIST(at).ymd}T15:30:00+05:30`),ordersExecuted:0});
      }
      const mkt=marketStatus(at),ist=new Date(at.getTime()+19800000),minute=ist.getUTCHours()*60+ist.getUTCMinutes();
      if(!mkt.open||minute<480||minute>=930)return res.status(200).json({status:'skipped',reason:!mkt.open?mkt.reason:'outside research/market hours',paperTrading:true});
      if(minute<555)action='research';
      else if(action==='research')action='scan';
      const registryAge=at.getTime()-Date.parse(registryFetchedAt);
      const entryPause=action==='scan'&&(!Number.isFinite(registryAge)||registryAge<0||registryAge>7*86400000)?'registry_stale':null;
      // A stale discovery registry blocks NEW entries, never protection of a held position.
      if(entryPause)action='risk';
      if(Math.floor(at.getTime()/300000)*300000<=(initial.data.lastSlots[action]||0))return res.status(200).json({status:'duplicate',paperTrading:true,entryPause});
      const date=nowIST(at).ymd;
      let market={quotes:{},candidates:[],references:{},candles:{},safetyReady:false,negativeSymbols:[],entryPause};
      // Optional news outages must never suppress price-based protection. Missing
      // mandatory surveillance context blocks new entries, not existing-position exits.
      try{Object.assign(market,await safety(at));}catch{market.researchUnavailable=true;}
      if(action==='research'){
        market.candidates=members.filter(m=>m.instrumentKey&&['mid','small'].includes(m.marketCapBucket)&&market.researchBySymbol?.[m.symbol])
          .sort((a,b)=>Number(market.researchBySymbol[b.symbol].verified)-Number(market.researchBySymbol[a.symbol].verified)).slice(0,12);
        for(let retry=0;retry<4;retry++){
          const current=retry?await read(FILE):initial;
          const result=transitionSimulation(current.data,market,{at:now(),action,config});
          if(!result.changed||await write(result.state,current.sha))return res.status(200).json({status:result.status,
            paperTrading:true,candidates:result.state.suggestions,ordersExecuted:0});
        }
        throw Error('research state conflict');
      }
      // Price risk takes priority over all candidate research; commit exits first.
      const heldKeys=initial.data.positions.map(p=>p.instrumentKey);
      if(heldKeys.length)market.quotes=await quotes(heldKeys);
      let first=initial;
      if(action==='scan'&&heldKeys.length){
        for(let retry=0;retry<4;retry++){
          const result=transitionSimulation(first.data,market,{at:now(),action:'risk',config});
          if(!result.changed||await write(result.state,first.sha)){first=await read(FILE);break;}
          if(retry===3)throw Error('risk state conflict');first=await read(FILE);
        }
      }
      let preparedReferences={};
      if(action==='scan'){
        const scanMembers=members.filter(m=>['mid','small'].includes(m.marketCapBucket)&&m.instrumentKey);
        for(const batch of quoteBatches(scanMembers))Object.assign(market.quotes,await quotes(batch));
        Object.assign(market.quotes,await quotes(['NSE_INDEX|Nifty 50']));
        const day=first.data.days[date]||{buys:[],exits:[]};
        const discovery=rankSimulationUniverse(scanMembers,market.quotes,{at:now(),...market,
          blocked:[...first.data.positions.map(p=>p.ticker),...day.buys,...day.exits]});
        const bySymbol=new Map(scanMembers.map(m=>[m.symbol,m]));
        // Reserve up to two slots for current morning/news research, but only AFTER
        // it passes the identical quote, circuit and momentum discovery safeguards.
        const priority=discovery.ranked.filter(r=>market.researchBySymbol?.[r.symbol]&&!market.researchBySymbol[r.symbol].negative).slice(0,2);
        const pending=discovery.ranked.filter(r=>{const p=first.data.pendingEntries?.[r.symbol],age=now().getTime()-Date.parse(p?.signalAt);
          return age>=0&&age<=15*60000;}).slice(0,4);
        const shortlist=[...new Map([...pending,...priority,...discovery.ranked].map(r=>[r.symbol,r])).values()].slice(0,8)
          .sort((a,b)=>b.discoveryScore-a.discoveryScore);
        market.candidates=shortlist.map(r=>({...bySymbol.get(r.symbol),discoveryScore:r.discoveryScore}));
        market.discovery={at:now().toISOString(),requested:scanMembers.length,
          quotesReceived:scanMembers.filter(m=>market.quotes[m.instrumentKey]).length,shortlisted:market.candidates.length,
          rejected:discovery.rejected.slice(0,30),source:'Upstox',registryAt:registry.fetchedAt};
        const from=new Date(at.getTime()-100*86400000).toISOString().slice(0,10);
        // One extra candle request per scan, reused by every candidate. Never
        // substitute the daily percentage move if short-term index history fails.
        const benchmarkHistory=config.entryMode?intraday('NSE_INDEX|Nifty 50')
          .then(rows=>{market.benchmarkCandles=rows;}).catch(()=>{market.benchmarkCandles=[];}):Promise.resolve();
        await Promise.all([benchmarkHistory,...market.candidates.map(async c=>{
          const cached=first.data.dailyCache[c.symbol];
          const cachedReady=cached?.asOf===date&&(!config.entryMode||(cached.version===2&&cached.contextVersion===1));
          const [minutes,history]=await Promise.allSettled([intraday(c.instrumentKey),cachedReady?cached:
            daily(c.instrumentKey,from,date).then(rows=>dailyReference(rows,date))]);
          if(minutes.status==='fulfilled')market.candles[c.symbol]=minutes.value;
          if(history.status==='fulfilled'&&history.value)preparedReferences[c.symbol]=history.value;
          const missing=[];
          if(minutes.status!=='fulfilled')missing.push('Upstox intraday history request failed');
          if(history.status!=='fulfilled'||!history.value)missing.push('Upstox daily history failed validation or warm-up');
          if(missing.length){market.historyErrors??={};market.historyErrors[c.symbol]=missing;}
        })]);
        // Refresh executable quotes AFTER all slower history work. Never book an earlier quote.
        const refreshKeys=[...new Set([...heldKeys,...market.candidates.map(c=>c.instrumentKey),'NSE_INDEX|Nifty 50'])];
        if(refreshKeys.length)Object.assign(market.quotes,await quotes(refreshKeys));
        market.references=preparedReferences;
      }
      for(let retry=0;retry<4;retry++){
        at=now();const current=retry?await read(FILE):first;validateSimulation(current.data);
        const result=transitionSimulation(current.data,market,{at,action,config});
        Object.assign(result.state.dailyCache,preparedReferences);
        if(!result.changed)return res.status(200).json({status:result.status,paperTrading:true});
        if(await write(result.state,current.sha))return res.status(result.status==='partial'?502:200).json({status:result.status,
          mode:'experimental-paper-only',paperTrading:true,bought:result.bought,checked:result.checked,
          dailyInvestment:config.dailyInvestment,fundingMode:config.fundingMode,sharesPerEntry:config.sharesPerEntry,
          strategyVersion:config.version,entryMode:config.entryMode??'baseline',executionRuleVersion:config.executionRuleVersion,
          dayInvested:result.state.days[date]?.invested||0,positions:result.state.positions.length,
          candidates:result.state.suggestions,discovery:result.state.discovery,entryPause,ordersExecuted:0});
      }
      throw Error('simulation state conflict');
    }catch{return res.status(502).json({status:'simulation_failed',reason:'check quote access, safety context and atomic ledger persistence; no real orders exist',paperTrading:true});}
  };
}
export default createSimulationHandler();
