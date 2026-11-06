// Read-only exact-logic replay after point-in-time evidence starts accumulating.
import {execFileSync} from 'node:child_process';
import {replayPointInTimeEntries} from '../research/point-in-time-entry-replay.js';
const dates=process.argv.slice(2);if(!dates.length||dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)))throw Error('Supply YYYY-MM-DD sessions');
const git=a=>execFileSync('git',a,{encoding:'utf8',maxBuffer:30000000}),records=[];
for(const date of dates){
  const hashes=git(['log','origin/main',`--since=${date}T00:00:00+05:30`,`--until=${date}T23:59:59+05:30`,'--format=%H','--','data/paper-simulation.json']).trim().split('\n').filter(Boolean);
  for(const sha of hashes)records.push(JSON.parse(git(['show',`${sha}:data/paper-simulation.json`])));
}
const report=replayPointInTimeEntries(records);
console.log(JSON.stringify({...report,variants:report.variants.map(({state,...v})=>({...v,entries:Object.values(state.days).reduce((s,d)=>s+d.buys.length,0)}))},null,2));
