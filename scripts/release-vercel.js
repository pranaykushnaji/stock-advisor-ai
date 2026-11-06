// Explicit normal deployment through Vercel CLI. No tokens are read or copied.
// This obeys Vercel quotas; there is no retry loop or rate-limit workaround.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {releasePreflight} from '../research/deployment-policy.js';
const args=process.argv.slice(2),checkOnly=args.length===1&&args[0]==='--check';
if(args.length!==1||!['--check','--production','--preview'].includes(args[0]))throw Error('Use --check, --preview or --production');
const mode=args[0]==='--preview'?'preview':'production';
const git=a=>execFileSync('git',a,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if(!checkOnly&&mode==='production')execFileSync('git',['fetch','origin','main'],{stdio:'inherit'});
let projectId=null;try{projectId=JSON.parse(readFileSync(new URL('../.vercel/project.json',import.meta.url),'utf8')).projectId;}catch{}
const status=releasePreflight({mode,head:git(['rev-parse','HEAD']),originMain:git(['rev-parse','origin/main']),
  dirty:!!git(['status','--porcelain']),projectId});
console.log(JSON.stringify({...status,checkOnly,ordersExecuted:0},null,2));
if(checkOnly)process.exit(status.ready?0:1);
if(!status.ready)throw Error(status.reasons.join('; '));
for(const command of [['npm',['test']],['npm',['run','check']],['vercel',['deploy',...(mode==='production'?['--prod']:[]),'--yes']]]){
  const result=spawnSync(command[0],command[1],{stdio:'inherit'});
  if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
}
