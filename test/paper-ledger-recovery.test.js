import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createSimulationHandler, readSimulationJson} from '../api/_paper-simulation-handler.js';
import {emptySimulation} from '../api/_paper-simulation.js';
import {runWatchdog, watchdogPlan} from '../scripts/cron-watchdog.js';

const env={GITHUB_TOKEN:'test',UPSTOX_ACCESS_TOKEN:'test',PAPER_SIMULATION_ENABLED:'true'};
const path='data/paper-simulation.json';
const iso=(time,day='12')=>new Date(`2026-11-${day}T${time}:00+05:30`);
const bytes=Buffer.from(JSON.stringify({...emptySimulation(),padding:'x'.repeat(1048576)}));
const shaFor=b=>createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const meta=b=>({type:'file',sha:shaFor(b),size:b.length,encoding:'none',content:''});

test('oversized GitHub file is read from the exact blob SHA and still validates in the no-write health check',async()=>{
  const metadata=meta(bytes);
  let reads=0;
  const read=()=>readSimulationJson(path,env,async(url,opt)=>{
    assert.equal(opt.redirect,'error');
    reads++;
    if(reads===1){
      assert.match(url,/\/contents\/data\/paper-simulation\.json\?ref=main$/);
      assert.equal(opt.headers.Accept,'application/vnd.github.object+json');
      return Response.json(metadata);
    }
    assert.ok(url.endsWith('/git/blobs/'+metadata.sha));
    assert.equal(opt.headers.Accept,'application/vnd.github.raw+json');
    return new Response(bytes);
  });
  const secret=process.env.CRON_SECRET;
  process.env.CRON_SECRET='ledger-test';
  try{
    const member={symbol:'ABC',instrumentKey:'NSE_EQ|INE123'};
    const handler=createSimulationHandler({env,read,now:()=>iso('00:30'),members:[member],
      quotes:async()=>({[member.instrumentKey]:{price:100}}),write:async()=>assert.fail('health must not write')});
    const res={status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',headers:{authorization:'Bearer ledger-test'},body:{mode:'health'}},res);
    assert.equal(reads,2);
    assert.equal(res.code,200);
    assert.equal(res.body.status,'ready');
    assert.equal(res.body.ordersExecuted,0);
  }finally{if(secret===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=secret;}
});

test('small inline files keep their fast path and version for atomic writes',async()=>{
  const small=Buffer.from('{"cash":100}');
  const metadata=meta(small);
  let calls=0;
  const r=await readSimulationJson(path,env,async()=>{
    calls++;
    return Response.json({...metadata,encoding:'base64',content:small.toString('base64')});
  });
  assert.deepEqual(r,{data:{cash:100},sha:metadata.sha});
  assert.equal(calls,1);
});

test('missing or mismatched large blobs fail closed instead of pairing stale data with a new SHA',async()=>{
  for(const [response,error] of [
    [new Response(null,{status:404}),/blob unavailable/],
    [new Response(Buffer.alloc(bytes.length,32)),/does not match/]
  ]){
    await assert.rejects(readSimulationJson(path,env,async url=>url.includes('/contents/')
      ?Response.json(meta(bytes)):response),error);
  }
});

const logRow=(job,time,ok=true,day='12',trigger='cron')=>({
  job,trigger,ts:iso(time,day).toISOString(),summary:{ok,httpStatus:ok?200:502,
    detail:ok?`{"status":"${job.endsWith('-research')?'researched':'processed'}","truncated":[`:'error code: 502'}
});
const scan=(time,ok,day,trigger)=>logRow('paper-simulation-scan',time,ok,day,trigger);
const snapshot=time=>logRow('nse-snapshot',time);

test('watchdog ignores unrelated green jobs, missing telemetry, and yesterday’s scans',()=>{
  const rows=[snapshot('11:45'),scan('11:55',false),scan('12:01',true,'11'),scan('12:01',true,'12','manual')];
  const p=watchdogPlan(rows,iso('12:02'));
  assert.equal(p.paperAction,'scan');
  assert.equal(p.snapshot,false);
  assert.match(p.issues.join(' '),/HTTP 502/);
  assert.equal(watchdogPlan(null,iso('12:02')).paperAction,'scan');
});

test('watchdog alerts on recent failures but avoids rerunning a recovered scan',()=>{
  const rows=[scan('12:00'),scan('11:55',false),snapshot('11:45')];
  const p=watchdogPlan(rows,iso('12:02'));
  assert.equal(p.paperAction,null);
  assert.match(p.issues.join(' '),/1 failed paper scan/);
  assert.deepEqual(watchdogPlan([scan('12:00'),snapshot('11:45')],iso('12:02')).issues,[]);
  const disabled=scan('12:00');
  disabled.summary.detail='{"status":"disabled"}';
  assert.equal(watchdogPlan([disabled,snapshot('11:45')],iso('12:02')).paperAction,'scan');
});

test('watchdog audits after hours without trading, honours holiday and morning grace',()=>{
  const p=watchdogPlan([scan('15:25',false)],iso('17:30'));
  assert.equal(p.paperAction,null);
  assert.equal(p.snapshot,false);
  assert.deepEqual(p.endOfDay,[]);
  assert.match(p.issues.join(' '),/failed paper job|scans missing/);
  assert.equal(watchdogPlan([],iso('10:00','10')).skipped,'holiday:2026-11-10');
  assert.equal(watchdogPlan([],iso('08:10')).paperAction,null);
  assert.equal(watchdogPlan([],iso('08:22')).paperAction,'research');
});

test('watchdog recovery uses the paper engine, and health-only sends one no-write diagnostic',async()=>{
  const seen=[],log=[];
  const fetchImpl=async(url,options)=>{
    seen.push({url,method:options.method,body:options.body});
    if(url.endsWith('/log'))return Response.json([scan('12:00',false),snapshot('11:45')]);
    if(options.body)return Response.json({status:'ready',positions:8,trades:15,
      ordersExecuted:0,quotesRequested:1,quotesReceived:1});
    return Response.json({status:'processed',ordersExecuted:0});
  };
  const opts={at:iso('12:02'),env:{CRON_SECRET:'test'},fetchImpl,log:s=>log.push(s)};
  assert.equal(await runWatchdog(opts),1);
  assert.equal(seen.length,2);
  assert.match(seen[1].url,/\/api\/paper-simulation\?action=scan$/);
  assert.equal(seen[1].method,'POST');
  assert.match(log.join(' '),/fallback: completed/);
  seen.length=0;
  assert.equal(await runWatchdog({...opts,env:{...opts.env,HEALTH_ONLY:'true'}}),0);
  assert.equal(seen.length,1);
  assert.match(seen[0].url,/\?action=risk$/);
  assert.deepEqual(JSON.parse(seen[0].body),{mode:'health'});
});
