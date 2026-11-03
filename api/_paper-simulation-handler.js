import { requireCronAuth } from './_cron-auth.js';
import { marketStatus, nowIST } from './_market-calendar.js';
import { fetchFullQuotes, fetchIntradayOneMinuteCandles, fetchDailyCandles } from './_upstox-market-data.js';
import { quoteBatches } from '../research/coverage.js';
import registry from '../research/universe.json' with {type:'json'};
import { rankSimulationUniverse, transitionSimulation, validateSimulation, dailyReference } from './_paper-simulation.js';

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
async function loadSafety(env,at) {
  const [snap,mem]=await Promise.all([readFile('data/nse-snapshot.json',env),readFile('data/catalyst-memory.json',env)]);
  const ms=Date.parse(snap.data.fetchedAt),age=at.getTime()-ms;
  const safetyReady=Number.isFinite(ms)&&age>=0&&age<=4*3600000&&snap.data.diag?.surveillance===true&&Array.isArray(snap.data.data?.surveillance);
  const negativeSymbols=Object.entries(mem.data.catalysts||{}).filter(([,c])=>{
    const cat=c.catalyst||c;
    return cat.negative===true&&cat.verification==='VERIFIED'&&cat.evidenceVersion>=2
      && Number.isFinite(cat.eventPublishedAt)&&at.getTime()-cat.eventPublishedAt>=0&&at.getTime()-cat.eventPublishedAt<=72*3600000;
  }).map(([sym])=>sym);
  // Official-subject risk flags are conservative review exclusions, not an LLM claim
  // that a crime occurred. Full filing interpretation remains a separate research task.
  for(const a of snap.data.data?.announcements||[]){
    if(/fraud|insolvency|bankrupt|order cancellation|default on|sebi.*(penalty|action)|investigation/i.test(a.subject||''))negativeSymbols.push(a.symbol);
  }
  return {safetyReady,surveillance:snap.data.data?.surveillance||[],negativeSymbols};
}

export function createSimulationHandler({env=process.env,now=()=>new Date(),read=path=>readFile(path,env),
  write=(state,sha)=>writeFile(state,sha,env),quotes=fetchFullQuotes,intraday=fetchIntradayOneMinuteCandles,
  daily=fetchDailyCandles,safety=at=>loadSafety(env,at),members=registry.members}={}){
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
    if(!['risk','scan'].includes(action))return res.status(400).json({error:'unknown simulation action'});
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
        return res.status(200).json({status:'ready',mode:'experimental-paper-only',dailyInvestment:10000,
          positions:initial.data.positions.length,trades:initial.data.trades.length,
          registryMapped:members.filter(m=>m.instrumentKey).length,quotesRequested:checkedMembers.length,quotesReceived:Object.keys(q).length,candleAccess,
          marketOpen:marketStatus(at).open&&at.getTime()>=Date.parse(`${nowIST(at).ymd}T09:15:00+05:30`)
            &&at.getTime()<Date.parse(`${nowIST(at).ymd}T15:30:00+05:30`),ordersExecuted:0});
      }
      const mkt=marketStatus(at),ist=new Date(at.getTime()+19800000),minute=ist.getUTCHours()*60+ist.getUTCMinutes();
      if(!mkt.open||minute<555||minute>=930)return res.status(200).json({status:'skipped',reason:!mkt.open?mkt.reason:'outside market hours',paperTrading:true});
      // The opening/closing ticks still protect existing positions even when new entries stop.
      if(action==='scan'&&(minute<590||minute>885))action='risk';
      if(Math.floor(at.getTime()/300000)*300000<=(initial.data.lastSlots[action]||0))return res.status(200).json({status:'duplicate',paperTrading:true});
      const registryAge=at.getTime()-Date.parse(registry.fetchedAt);
      if(action==='scan'&&(!Number.isFinite(registryAge)||registryAge<0||registryAge>7*86400000))return res.status(503).json({status:'registry_stale'});
      const date=nowIST(at).ymd;
      let market={quotes:{},candidates:[],references:{},candles:{},safetyReady:false,negativeSymbols:[]};
      // Price risk takes priority over all candidate research; commit exits first.
      const heldKeys=initial.data.positions.map(p=>p.instrumentKey);
      if(heldKeys.length)market.quotes=await quotes(heldKeys);
      let first=initial;
      if(action==='scan'&&heldKeys.length){
        for(let retry=0;retry<4;retry++){
          const result=transitionSimulation(first.data,market,{at:now(),action:'risk'});
          if(!result.changed||await write(result.state,first.sha)){first=await read(FILE);break;}
          if(retry===3)throw Error('risk state conflict');first=await read(FILE);
        }
      }
      let preparedReferences={};
      if(action==='scan'){
        const context=await safety(at);Object.assign(market,context);
        const scanMembers=members.filter(m=>['mid','small'].includes(m.marketCapBucket)&&m.instrumentKey);
        for(const batch of quoteBatches(scanMembers))Object.assign(market.quotes,await quotes(batch));
        Object.assign(market.quotes,await quotes(['NSE_INDEX|Nifty 50']));
        const day=first.data.days[date]||{buys:[],exits:[]};
        const discovery=rankSimulationUniverse(scanMembers,market.quotes,{at:now(),...context,
          blocked:[...first.data.positions.map(p=>p.ticker),...day.buys,...day.exits]});
        const bySymbol=new Map(scanMembers.map(m=>[m.symbol,m]));
        market.candidates=discovery.ranked.slice(0,8).map(r=>({...bySymbol.get(r.symbol),discoveryScore:r.discoveryScore}));
        market.discovery={at:now().toISOString(),requested:scanMembers.length,
          quotesReceived:scanMembers.filter(m=>market.quotes[m.instrumentKey]).length,shortlisted:market.candidates.length,
          rejected:discovery.rejected.slice(0,30),source:'Upstox',registryAt:registry.fetchedAt};
        const from=new Date(at.getTime()-100*86400000).toISOString().slice(0,10);
        await Promise.all(market.candidates.map(async c=>{
          try{
            const cached=first.data.dailyCache[c.symbol];
            const [candles,reference]=await Promise.all([intraday(c.instrumentKey),cached?.asOf===date?cached:daily(c.instrumentKey,from,date).then(rows=>dailyReference(rows,date))]);
            market.candles[c.symbol]=candles;if(reference)preparedReferences[c.symbol]=reference;
          }catch{/* Missing evidence is a rejection, never a fabricated signal. */}
        }));
        // Refresh executable quotes AFTER all slower history work. Never book an earlier quote.
        if(market.candidates.length)Object.assign(market.quotes,await quotes(market.candidates.map(c=>c.instrumentKey)));
        market.references=preparedReferences;
      }
      for(let retry=0;retry<4;retry++){
        at=now();const current=retry?await read(FILE):first;validateSimulation(current.data);
        const result=transitionSimulation(current.data,market,{at,action});
        Object.assign(result.state.dailyCache,preparedReferences);
        if(!result.changed)return res.status(200).json({status:result.status,paperTrading:true});
        if(await write(result.state,current.sha))return res.status(result.status==='partial'?502:200).json({status:result.status,
          mode:'experimental-paper-only',paperTrading:true,bought:result.bought,checked:result.checked,
          dailyInvestment:10000,dayInvested:result.state.days[date]?.invested||0,positions:result.state.positions.length,
          candidates:result.state.suggestions,discovery:result.state.discovery,ordersExecuted:0});
      }
      throw Error('simulation state conflict');
    }catch{return res.status(502).json({status:'simulation_failed',reason:'check quote access, safety context and atomic ledger persistence; no real orders exist',paperTrading:true});}
  };
}
export default createSimulationHandler();
