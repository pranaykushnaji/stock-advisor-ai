import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLiveRegistryLoader,validateLiveRegistry,LIVE_REGISTRY_URL} from '../api/_live-registry.js';
import {createLiveSimulationHandler} from '../api/_paper-simulation-handler.js';
import {emptySimulation} from '../api/_paper-simulation.js';
import {isMutableMarketPath,releasePreflight,VERCEL_PROJECT_ID} from '../research/deployment-policy.js';
const at=new Date('2026-11-06T10:00:05+05:30'),clock=at.getTime();
const member={symbol:'ABC',instrumentKey:'NSE_EQ|INE123',marketCapBucket:'mid',sector:'IT'};
const registry=(symbol='ABC',ms=clock)=>({version:'research-universe-v1',fetchedAt:new Date(ms).toISOString(),members:[{...member,symbol}]});
test('data routing and Git configuration separate mutable JSON from code deployments',()=>{
  const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
  const policy=JSON.parse(readFileSync(new URL('../deployment/vercel-project-policy.json',import.meta.url),'utf8'));
  assert.equal(config.git.deploymentEnabled,false);assert.equal(policy.gitProviderOptions.createDeployments,'disabled');
  assert.equal(config.rewrites.find(r=>r.source==='/data/:path*').destination,
    'https://raw.githubusercontent.com/pranaykushnaji/stock-advisor-ai/main/data/:path*');
  assert.equal(config.rewrites.find(r=>r.source==='/research/universe.json').destination,LIVE_REGISTRY_URL);
  const excluded=readFileSync(new URL('../.vercelignore',import.meta.url),'utf8');
  assert.match(excluded,/data\/\*\*/);assert.match(excluded,/research\/universe\.json/);
  assert.ok(isMutableMarketPath('data/paper-simulation.json'));assert.ok(isMutableMarketPath('research/universe.json'));
  assert.equal(isMutableMarketPath('api/sell-check.js'),false);
});
test('manual release preflight blocks dirty, wrong-project or unfetched production code',()=>{
  const good={mode:'production',head:'a'.repeat(40),originMain:'a'.repeat(40),dirty:false,projectId:VERCEL_PROJECT_ID};
  assert.equal(releasePreflight(good).ready,true);
  for(const bad of [{dirty:true},{projectId:'wrong'},{originMain:'b'.repeat(40)},{mode:'unknown'},{head:'bad'}])
    assert.equal(releasePreflight({...good,...bad}).ready,false);
  assert.equal(releasePreflight({...good,mode:'preview',originMain:'b'.repeat(40)}).ready,true);
});
test('registry refreshes without deployment, coalesces concurrent reads and cannot be mutated by callers',async()=>{
  let now=clock,calls=0,name='ABC';
  const load=createLiveRegistryLoader({now:()=>now,ttlMs:1000,fetchImpl:async(url,options)=>{
    assert.equal(url,LIVE_REGISTRY_URL);assert.equal(options.cache,'no-store');calls++;return {ok:true,json:async()=>registry(name,now)};}});
  const [a,b]=await Promise.all([load(),load()]);assert.equal(calls,1);a.members[0].symbol='TAMPER';
  assert.equal(b.members[0].symbol,'ABC');assert.equal((await load()).members[0].symbol,'ABC');
  now+=1001;name='XYZ';assert.equal((await load()).members[0].symbol,'XYZ');assert.equal(calls,2);
});
test('stale, future, duplicated and malformed registry data cannot authorize discovery',async()=>{
  const base=registry();
  for(const bad of [{...base,fetchedAt:new Date(clock-8*86400000).toISOString()},
    {...base,fetchedAt:new Date(clock+1).toISOString()}, {...base,members:[member,member]},
    {...base,members:[{...member,instrumentKey:'NSE_FO|123'}]}, {...base,members:[]}])
    assert.throws(()=>validateLiveRegistry(bad,clock),/registry/);
  let calls=0;const load=createLiveRegistryLoader({now:()=>clock,fetchImpl:async()=>{calls++;return {ok:false};}});
  await assert.rejects(load,/fetch failed/);await assert.rejects(load,/fetch failed/);assert.equal(calls,2);
});
test('live handler reads current registry for health but never writes an account in that diagnostic',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='registry-test';let loads=0,writes=0;
  const handler=createLiveSimulationHandler({env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},
    now:()=>at,registryLoader:async()=>{loads++;return registry('NEW');},read:async()=>({data:emptySimulation(),sha:'x'}),
    write:async()=>{writes++;return true;},quotes:async()=>({})});
  const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  try{await handler({method:'POST',query:{action:'risk'},body:{mode:'health'},headers:{authorization:'Bearer registry-test'}},res);
    assert.equal(res.code,200);assert.equal(loads,1);assert.equal(writes,0);assert.equal(res.body.registryMapped,1);
  }finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
test('registry outages and deployment decoupling cannot suppress an existing position stop',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='registry-test';
  try{for(const action of ['risk','scan']){
    let loads=0,state=emptySimulation();state.contributions=100.15;
    state.positions=[{...member,id:'p',ticker:'ABC',date:'2026-11-06',addedAt:'2026-11-06T04:00:00Z',shares:1,
      entryPrice:100,initialStopPrice:99,investedAmount:100,entryCost:.15,modeledInitialRisk:1.35,
      lastObservedAt:'2026-11-06T04:00:00Z',peakPrice:100}];
    const handler=createLiveSimulationHandler({env:{PAPER_SIMULATION_ENABLED:'true',UPSTOX_ACCESS_TOKEN:'test',GITHUB_TOKEN:'test'},now:()=>at,
      registryLoader:async()=>{loads++;throw Error('outage');},read:async()=>({data:structuredClone(state),sha:'x'}),write:async s=>{state=s;return true;},
      safety:async()=>{throw Error('news outage');},quotes:async()=>({[member.instrumentKey]:{...member,price:98,bidPrice:97.98,lastTradeAt:at.toISOString(),responseAt:at.toISOString()}})});
    const res={setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',query:{action},headers:{authorization:'Bearer registry-test'}},res);
    assert.equal(res.code,200);assert.equal(state.positions.length,0);assert.equal(state.trades.length,1);
    assert.equal(loads,action==='risk'?0:1);assert.equal(res.body.ordersExecuted,0);
    if(action==='scan')assert.equal(res.body.entryPause,'registry_stale');
  }}finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
test('unauthorized callers never trigger a registry download',async()=>{
  const old=process.env.CRON_SECRET;process.env.CRON_SECRET='registry-test';let loads=0;
  const handler=createLiveSimulationHandler({registryLoader:async()=>{loads++;return registry();}});
  const res={status(code){this.code=code;return this;},json(){return this;}};
  try{await handler({method:'POST',query:{action:'scan'},headers:{}},res);assert.equal(res.code,401);assert.equal(loads,0);}
  finally{if(old==null)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=old;}
});
