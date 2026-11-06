// Read committed state only. Usage: node scripts/review-paper-performance.js 2026-11-04 2026-11-05
import {execFileSync} from 'node:child_process';
import {reviewPaperSession} from '../research/session-review.js';
import {performanceSummary} from '../desk/performance.js';
import {entryCohortPerformance} from '../research/entry-cohorts.js';
const dates=process.argv.slice(2);
if(!dates.length||dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))))throw Error('Supply exchange-session dates as YYYY-MM-DD');
const git=args=>execFileSync('git',args,{encoding:'utf8',maxBuffer:30000000});
const file='data/paper-simulation.json',ref='origin/main';
const at=sha=>JSON.parse(git(['show',`${sha}:${file}`]));
const sessions=dates.map(date=>{
  const hashes=git(['log',ref,`--since=${date}T00:00:00+05:30`,`--until=${date}T23:59:59+05:30`,'--format=%H','--',file]).trim().split('\n').filter(Boolean);
  return reviewPaperSession(hashes.map(at),date);
});
const state=at(ref);
console.log(JSON.stringify({sourceCommit:git(['rev-parse',ref]).trim(),generatedAt:new Date().toISOString(),
  accountAsOf:state.updatedAt,performance:performanceSummary(state),entryCohorts:entryCohortPerformance(state),sessions},null,2));
