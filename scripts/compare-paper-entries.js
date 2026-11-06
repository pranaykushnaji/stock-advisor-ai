// stdout report only. Never adds hypothetical positions to the live ledger.
import {loadReplaySession} from '../research/replay-input.js';
import {compareEntryVariants} from '../research/entry-comparison.js';
const compact=process.argv.includes('--summary'),dates=process.argv.slice(2).filter(s=>s!=='--summary');
if(!dates.length)throw Error('Supply session dates YYYY-MM-DD');
const inputs=[];
for(const date of dates){console.error(`Loading archived decisions and dated candles: ${date}`);inputs.push(await loadReplaySession(date));}
const report=compareEntryVariants(inputs);
if(compact)report.variants=report.variants.map(v=>({...v,sessions:v.sessions.map(({rows,rejectionCounts,...s})=>s)}));
console.log(JSON.stringify(report,null,2));
