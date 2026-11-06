// Node-only, read-only historical input loader. No credentials or account writes.
import {execFileSync} from 'node:child_process';
import {dailyReference} from '../api/_paper-simulation.js';
import {liveSimulationEntry} from '../api/_entry-research.js';
const git=args=>execFileSync('git',args,{encoding:'utf8',maxBuffer:30000000});
const fileAt=(sha,path)=>JSON.parse(git(['show',`${sha}:${path}`]));
const dateOf=ms=>new Date(ms+19800000).toISOString().slice(0,10);
const cache=new Map();
export async function publicCandles(symbol,date,interval='1m'){
  const key=[symbol,date,interval].join('|');if(cache.has(key))return cache.get(key);
  const request=(async()=>{
    const midnight=Date.parse(date+'T00:00:00+05:30');
    const start=midnight-(interval==='1d'?100*86400000:0),end=midnight+86400000;
    const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${Math.floor(start/1000)}&period2=${Math.floor(end/1000)}&interval=${interval}`;
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error(`history HTTP ${r.status}`);
    const body=await r.json(),raw=body.chart?.result?.[0];if(!raw)throw Error('no historical chart');
    const q=raw.indicators?.quote?.[0]||{};
    const candles=(raw.timestamp||[]).map((t,i)=>[new Date(t*1000).toISOString(),q.open?.[i],q.high?.[i],q.low?.[i],q.close?.[i],q.volume?.[i]])
      .filter(row=>(interval==='1d'||dateOf(Date.parse(row[0]))===date)&&row.slice(1,5).every(n=>Number.isFinite(n)&&n>0)&&Number.isFinite(row[5])&&row[5]>=0);
    if(!candles.length)throw Error('no candles in requested session');
    return {candles,source:url};
  })();cache.set(key,request);return request;
}

// Delayed confirmation must not disappear because the OLD engine bought the
// stock and removed it from subsequent shortlists. Retain only observed signals.
export function retainPendingReplayCandidates(scans,series){
  const pending=new Map();let modeledQuotes=0;
  const result=scans.map(scan=>{
    const at=Date.parse(scan.at),original=new Set(scan.suggestions.map(r=>r.ticker));
    for(const row of scan.suggestions){
      const setup=liveSimulationEntry(series[row.ticker]?.candles||[],{price:row.price,lastTradeAt:row.observedAt},{now:new Date(at),regime:'neutral'});
      if(setup.status==='setup')pending.set(row.ticker,{row,signalAt:Date.parse(setup.signalAt)});
    }
    const carry=[];
    for(const [ticker,p] of pending){
      if(at-p.signalAt>15*60000||at<p.signalAt){pending.delete(ticker);continue;}
      if(original.has(ticker))continue;
      const last=(series[ticker]?.candles||[]).filter(r=>Date.parse(r[0])+60000<=at).sort((a,b)=>Date.parse(a[0])-Date.parse(b[0])).at(-1);
      if(!last||at-(Date.parse(last[0])+60000)>90000)continue;
      carry.push({...p.row,price:last[4],observedAt:new Date(Date.parse(last[0])+60000).toISOString(),
        priceBasis:'modeled completed minute close for previously observed pending signal'});modeledQuotes++;
    }
    return {...scan,suggestions:[...carry,...scan.suggestions]};
  });return {scans:result,modeledQuotes};
}

export async function loadReplaySession(date,ref='origin/main'){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date).toISOString().slice(0,10)!==date)throw Error('Expected valid YYYY-MM-DD');
  const hashes=file=>git(['log',ref,`--since=${date}T00:00:00+05:30`,`--until=${date}T23:59:59+05:30`,'--format=%H','--',file]).trim().split('\n').filter(Boolean).reverse();
  const states=hashes('data/paper-simulation.json').map(sha=>({sha,state:fileAt(sha,'data/paper-simulation.json')}))
    .filter(({state:s})=>s.lastCheck?.action==='scan'&&dateOf(Date.parse(s.updatedAt))===date);
  const snapshots=hashes('data/nse-snapshot.json').map(sha=>fileAt(sha,'data/nse-snapshot.json'));
  if(states.length)snapshots.push(fileAt(states[0].sha,'data/nse-snapshot.json'));
  const scans=states.map(({sha,state:s})=>{
    const at=Date.parse(s.updatedAt),snap=snapshots.filter(d=>Date.parse(d.fetchedAt)<=at).sort((a,b)=>Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt))[0];
    return {at:s.updatedAt,sourceCommit:sha,suggestions:s.suggestions,dailyCache:structuredClone(s.dailyCache),
      safetyReady:!!snap&&at-Date.parse(snap.fetchedAt)<=4*3600000&&snap.diag?.surveillance===true&&Array.isArray(snap.data?.surveillance),
      negativeSymbols:(snap?.data?.announcements||[]).filter(a=>/fraud|insolvency|bankrupt|order cancellation|default on|sebi.*(penalty|action)|investigation/i.test(a.subject||'')).map(a=>a.symbol)};
  });
  const names=[...new Set(scans.flatMap(s=>s.suggestions.map(r=>r.ticker)))],series={},errors={},references={};
  const load=async(ticker,symbol)=>{
    try{
      const [minute,daily]=await Promise.all([publicCandles(symbol,date),publicCandles(symbol,date,'1d')]);
      const before=daily.candles.filter(r=>dateOf(Date.parse(r[0]))<date).sort((a,b)=>Date.parse(a[0])-Date.parse(b[0]));
      if(!before.length)throw Error('prior-session close unavailable');
      const value={...minute,previousClose:before.at(-1)[4]};
      if(ticker==='NIFTY')return value;
      series[ticker]=value;references[ticker]=dailyReference(before,date);
    }catch(e){errors[ticker]=e.message;if(ticker!=='NIFTY')series[ticker]={candles:[]};return null;}
  };
  for(let i=0;i<names.length;i+=3)await Promise.all(names.slice(i,i+3).map(t=>load(t,t+'.NS')));
  const benchmark=await load('NIFTY','^NSEI');
  for(const scan of scans)for(const t of names){
    const historical=references[t],original=scan.dailyCache[t];
    // Reconstruct only prior movement; saved point-in-time EMA/liquidity wins.
    if(historical)scan.dailyCache[t]={...historical,...original,version:2,return5Pct:historical.return5Pct,previousClose:historical.previousClose};
  }
  const retained=retainPendingReplayCandidates(scans,series);
  return {date,scans:retained.scans,series,benchmark,source:{ref,lastCommit:states.at(-1)?.sha,
    archivedScans:scans.length,consideredTickers:names.length,availableIntradaySeries:Object.values(series).filter(s=>s.candles.length).length,
    historyFailures:errors,pendingModeledQuotes:retained.modeledQuotes,
    historicalProvider:'date-bounded Yahoo OHLC; saved Upstox shortlist quotes where available; NO historical depth'}};
}
