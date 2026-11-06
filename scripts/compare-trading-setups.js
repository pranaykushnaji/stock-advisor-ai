// Read-only report to stdout; never imports a handler, places orders or edits state.
import {execFileSync} from 'node:child_process';
import {compareSetupExperiments,SETUP_SCENARIOS} from '../research/setup-study.js';
import {loadReplaySession} from '../research/replay-input.js';
import {compareEntryVariants} from '../research/entry-comparison.js';
import {SETUP_RULES} from '../research/trading-setups.js';
import {EXIT_PROFILES} from '../research/setup-exits.js';
const estimated=process.argv.includes('--estimated'),compact=process.argv.includes('--summary'),dates=process.argv.slice(2).filter(s=>!['--estimated','--summary'].includes(s));
if(!dates.length||dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)))throw Error('Supply YYYY-MM-DD sessions');
if(estimated){
  const sessions=[];
  for(const date of dates){console.error('Loading estimated historical scenario: '+date);sessions.push(await loadReplaySession(date));}
  const report=compareEntryVariants(sessions,{scenarios:SETUP_SCENARIOS});
  report.mode='ESTIMATED-setup-and-exit-comparison';
  report.setupRules=SETUP_RULES;report.exitProfiles=EXIT_PROFILES;
  report.scenarioSettings=SETUP_SCENARIOS.map(({mode,config})=>({mode,setupMode:config.setupMode??null,
    entryMode:config.entryMode??'baseline',exitMode:config.exitMode??'baseline',allowedSetupTypes:config.allowedSetupTypes??null}));
  report.variants=report.variants.map(v=>({...v,sessions:v.sessions.map(({rows,...s})=>s)}));
  if(compact)report.variants=report.variants.map(v=>({...v,sessions:v.sessions.map(({cohorts,rejectionCounts,...s})=>s)}));
  console.log(JSON.stringify(report,null,2));
}else{
const git=a=>execFileSync('git',a,{encoding:'utf8',maxBuffer:30000000}),records=[];
for(const date of dates){
  const hashes=git(['log','origin/main',`--since=${date}T00:00:00+05:30`,`--until=${date}T23:59:59+05:30`,'--format=%H','--','data/paper-simulation.json'])
    .trim().split('\n').filter(Boolean);
  for(const sha of hashes){try{records.push(JSON.parse(git(['show',`${sha}:data/paper-simulation.json`])));}catch{/* Report only available committed frames. */}}
}
console.log(JSON.stringify(compareSetupExperiments(records),null,2));
}
