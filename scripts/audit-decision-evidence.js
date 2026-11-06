// stdout-only audit; never rewrites a trade, quantity, price, exit or P&L.
import {execFileSync} from 'node:child_process';
import {recoverDecisionEvidence} from '../research/decision-audit.js';
const ref=process.argv[2]||'origin/main';
const git=a=>execFileSync('git',a,{encoding:'utf8',maxBuffer:30000000});
const at=sha=>JSON.parse(git(['show',`${sha}:data/paper-simulation.json`]));
const state=at(ref),positions=[...state.positions,...state.trades].filter(p=>!p.synthetic&&!p.historicalReplay&&!p.voided);
const wanted=new Map(positions.map(p=>[p.id,p])),entries={};
const first=positions.map(p=>p.date||p.entryDate).filter(Boolean).sort()[0];
const hashes=first?git(['log',ref,`--since=${first}T00:00:00+05:30`,'--format=%H','--reverse','--','data/paper-simulation.json']).trim().split('\n').filter(Boolean):[];
for(const sha of hashes){
  const s=at(sha);
  for(const p of [...s.positions,...s.trades])if(wanted.has(p.id)&&s.lastCheck?.bought===p.ticker){
    const evidence=recoverDecisionEvidence(wanted.get(p.id),s,sha);
    if(evidence){entries[p.id]={id:p.id,ticker:p.ticker,entryAt:p.addedAt||p.entryAt,evidence};wanted.delete(p.id);}
  }
  if(!wanted.size)break;
}
console.log(JSON.stringify({version:1,mode:'original-decision-audit',sourceCommit:git(['rev-parse',ref]).trim(),asOf:state.updatedAt,
  entries,unresolved:[...wanted.keys()],limitation:'Only fields in the original buy commit are recovered; no contemporary data fills a historical gap.'},null,2));
