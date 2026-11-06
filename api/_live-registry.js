// Mutable market membership is runtime data, not a function-bundle dependency.
// Public source only; no tokens or environment values enter cache/client output.
export const LIVE_REGISTRY_URL='https://raw.githubusercontent.com/pranaykushnaji/stock-advisor-ai/main/research/universe.json';
export function validateLiveRegistry(value,nowMs=Date.now()){
  const age=nowMs-Date.parse(value?.fetchedAt),members=value?.members;
  if(value?.version!=='research-universe-v1'||!Number.isFinite(age)||age<0||age>7*86400000
    ||!Array.isArray(members)||!members.length||members.length>10000
    ||members.some(m=>!m||typeof m.symbol!=='string'||!/^[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(m.symbol)
      ||(m.instrumentKey!=null&&!/^NSE_EQ\|[A-Z0-9]+$/.test(m.instrumentKey)))
    ||new Set(members.map(m=>m.symbol)).size!==members.length)throw Error('Live registry missing, malformed or stale');
  return value;
}
export function createLiveRegistryLoader({fetchImpl=fetch,now=()=>Date.now(),ttlMs=600000}={}){
  let cached=null,loadedAt=0,inFlight=null;
  return async()=>{
    const ms=now();
    if(cached&&ms>=loadedAt&&ms-loadedAt<ttlMs){
      try{return structuredClone(validateLiveRegistry(cached,ms));}catch{cached=null;}
    }
    if(!inFlight)inFlight=(async()=>{
      const r=await fetchImpl(LIVE_REGISTRY_URL,{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(4000)});
      if(!r.ok)throw Error('Live registry fetch failed');
      const data=validateLiveRegistry(await r.json(),now());cached=structuredClone(data);loadedAt=now();return data;
    })().finally(()=>{inFlight=null;});
    return structuredClone(await inFlight);
  };
}
export const loadLiveRegistry=createLiveRegistryLoader();
