import {pathToFileURL} from 'node:url';
import {marketStatus, nowIST} from '../api/_market-calendar.js';

const WORKER='https://stock-advisor-cron.pranaykushnaji.workers.dev';
const VERCEL='https://stock-advisor-ai-omega.vercel.app';
const SNAPSHOT='https://api.github.com/repos/pranaykushnaji/stock-advisor-ai/actions/workflows/nse-snapshot.yml/dispatches';
const MIN=60000;
const minuteOfDay=at=>Math.floor((at.getTime()/MIN+330)%1440);
const healthy=row=>row?.summary?.ok===true&&row.summary.httpStatus>=200&&row.summary.httpStatus<300;
// The Worker truncates response bodies, so read the leading status field only.
const paperHealthy=row=>healthy(row)&&/^\s*\{\s*"status"\s*:\s*"(processed|researched|duplicate)"/.test(row.summary.detail??'');

export function watchdogPlan(records,at) {
  const session=marketStatus(at);
  const minute=minuteOfDay(at);
  const result={paperAction:null,snapshot:false,endOfDay:[],issues:[]};
  if(!session.open)return {...result,skipped:session.reason};
  const day=nowIST(at).ymd;
  const rows=(Array.isArray(records)?records:[]).flatMap(row=>{
    const ms=Date.parse(row?.ts);
    return row?.trigger==='cron'&&Number.isFinite(ms)&&ms<=at.getTime()&&nowIST(new Date(ms)).ymd===day
      ?[{...row,ms}]:[];
  }).sort((a,b)=>b.ms-a.ms);
  const job=name=>rows.filter(row=>row.job===name);
  const phase=minute>=495&&minute<555?'research':minute>=570&&minute<930?'scan':null;
  if(phase){
    const recent=job(`paper-simulation-${phase}`).filter(row=>at.getTime()-row.ms<=15*MIN);
    if(!paperHealthy(recent[0])){
      result.paperAction=phase;
      result.issues.push(recent.length?`Latest paper ${phase} did not complete (HTTP ${recent[0].summary?.httpStatus??'unknown'})`:
        `No paper ${phase} recorded in the past 15 minutes`);
    }
    const failures=recent.filter(row=>!paperHealthy(row)).length;
    if(failures)result.issues.push(`${failures} failed paper ${phase} run(s) in the past 15 minutes`);
  }
  if(minute>=930){
    // A late GitHub run must still detect an outage like Nov 11, even after 17:00.
    const scan=job('paper-simulation-scan');
    const failures=rows.filter(row=>row.job?.startsWith('paper-simulation-')&&!paperHealthy(row)).length;
    if(failures)result.issues.push(`${failures} failed paper job(s) recorded this session`);
    const times=scan.filter(paperHealthy).map(row=>minuteOfDay(new Date(row.ms))).filter(t=>t>=555).sort((a,b)=>a-b);
    if(!times.length||times[0]>570||times.at(-1)<915||times.some((t,i)=>i>0&&t-times[i-1]>15))
      result.issues.push('Paper scans missing for part or all of the market session');
  }
  // Keep the prior independent snapshot and end-of-day fallbacks, but do not
  // re-run them just because the unrelated paper engine failed.
  if(minute>=570&&minute<930&&!job('nse-snapshot').some(row=>healthy(row)&&at.getTime()-row.ms<=90*MIN)){
    result.snapshot=true;result.issues.push('No successful NSE snapshot dispatch in the past 90 minutes');
  }
  for(const [name,due] of [['refresh-prices',940],['analytics',970]]){
    if(minute>=due+10&&!job(name).some(healthy)){
      if(minute<=1020)result.endOfDay.push(name);
      result.issues.push(`No successful ${name} run recorded today`);
    }
  }
  return result;
}

export async function runWatchdog({at=new Date(),env=process.env,fetchImpl=fetch,log=console.log}={}) {
  const call=(url,options={})=>fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(options.method==='POST'?65000:15000)});
  const hit=async(path,body)=>{
    if(!env.CRON_SECRET)return {ok:false,result:'missing cron secret'};
    try{
      const r=await call(VERCEL+path,{method:'POST',headers:{Authorization:`Bearer ${env.CRON_SECRET}`,'Content-Type':'application/json'},
        ...(body?{body:JSON.stringify(body)}:{})});
      let data;try{data=await r.json();}catch{}
      return {ok:r.ok,status:r.status,data};
    }catch{return {ok:false,result:'network or timeout'};}
  };
  if(env.HEALTH_ONLY==='true'){
    const r=await hit('/api/paper-simulation?action=risk',{mode:'health'});
    const d=r.data;
    const ready=r.ok&&d?.status==='ready'&&d.ordersExecuted===0&&d.quotesRequested>0&&d.quotesReceived===d.quotesRequested;
    log(ready?`Paper health OK: ledger validated (${d.positions} open / ${d.trades} closed), registry and Upstox quote accessible. No writes or orders.`:
      `::error::Read-only paper health failed (${r.status??r.result??'unknown'}).`);
    return ready?0:1;
  }
  let records=[];
  try{const r=await call(WORKER+'/log');if(r.ok)records=await r.json();}catch{/* Missing telemetry is not a heartbeat. */}
  const plan=watchdogPlan(records,at);
  if(!plan.issues.length){log(plan.skipped??'No overdue jobs or paper failures detected.');return 0;}
  if(plan.paperAction){
    const r=await hit(`/api/paper-simulation?action=${plan.paperAction}`);
    const recovered=r.ok&&['processed','researched','duplicate'].includes(r.data?.status);
    log(`Paper ${plan.paperAction} fallback: ${recovered?'completed':'not confirmed'} (${r.status??r.result??'unknown'}).`);
  }
  if(plan.snapshot&&env.GH_TOKEN){
    try{
      const r=await call(SNAPSHOT,{method:'POST',headers:{Authorization:`Bearer ${env.GH_TOKEN}`,'Content-Type':'application/json'},
        body:JSON.stringify({ref:'main'})});
      log(`NSE snapshot fallback: HTTP ${r.status}.`);
    }catch{log('NSE snapshot fallback request failed.');}
  }
  for(const name of plan.endOfDay){
    const r=await hit('/api/'+name);
    log(`${name} fallback: ${r.status??r.result??'unknown'}.`);
  }
  for(const issue of plan.issues)log(`::error::${issue}`);
  return 1; // The workflow stays red for visibility even if a recovery request succeeded.
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=await runWatchdog();
