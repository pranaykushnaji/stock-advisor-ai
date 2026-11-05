// Browser reads only. Hidden tabs do not poll; overlapping requests are coalesced.
export function visibleRefresh({doc, win, refresh, intervalMs=60000}) {
  let busy=false, stopped=false;
  async function tick() {
    if(stopped || doc.hidden || busy)return;
    busy=true;
    try { await refresh(); } finally { busy=false; }
  }
  const timer=win.setInterval(()=>void tick(),intervalMs);
  const resume=()=>{if(!doc.hidden)void tick();};
  doc.addEventListener('visibilitychange',resume);
  return ()=>{stopped=true;win.clearInterval(timer);doc.removeEventListener('visibilitychange',resume);};
}
