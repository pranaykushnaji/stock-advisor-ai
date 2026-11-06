// Strict data contract, not a trading indicator. Invalid/conflicting observations
// are never silently averaged, filled forward, or treated as executable candles.
export function candleIntegrity(rows,{nowMs=Infinity,intervalMs=60000,date=null}={}){
  const byTime=new Map(),issues=[],invalidTimes=new Set();let forming=0,duplicates=0;
  for(const row of Array.isArray(rows)?rows:[]){
    if(!Array.isArray(row)){issues.push('invalid candle row');continue;}
    const ms=Date.parse(row?.[0]);
    if(!Number.isFinite(ms)){issues.push('invalid candle timestamp');continue;}
    if(ms+intervalMs>nowMs){forming++;continue;}
    if(date&&new Date(ms+19800000).toISOString().slice(0,10)!==date)continue;
    const [open,high,low,close,volume]=row.slice(1,6);
    const invalid=!Array.isArray(row)||row.length<6||![open,high,low,close].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)
      ||!Number.isFinite(volume)||volume<0||high<Math.max(open,close)||low>Math.min(open,close)||high<low;
    if(invalid){issues.push('invalid candle OHLCV geometry');invalidTimes.add(ms);byTime.delete(ms);continue;}
    if(invalidTimes.has(ms))continue;
    const previous=byTime.get(ms);
    if(previous){duplicates++;
      if(previous.slice(1,6).some((v,i)=>v!==row[i+1])){
        issues.push('conflicting duplicate candle');invalidTimes.add(ms);byTime.delete(ms);
      }
    }else byTime.set(ms,row.slice(0,6));
  }
  return {rows:[...byTime].sort((a,b)=>a[0]-b[0]).map(([,r])=>r),
    issues:[...new Set(issues)],invalidCount:invalidTimes.size,forming,duplicates};
}
