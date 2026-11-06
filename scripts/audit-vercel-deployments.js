// Read-only Vercel audit. CLI owns authentication; never reads or prints credentials.
import {execFileSync} from 'node:child_process';
const date=process.argv[2];
if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw Error('Supply IST date YYYY-MM-DD');
const ownerWindow=process.argv.includes('--rolling-owner'),clock=Date.now();
const since=ownerWindow?clock-86400000:Date.parse(date+'T00:00:00+05:30'),end=ownerWindow?clock:since+86400000;
const project='prj_Tlfw4In0eSsMIogUU80JGUgrDKfr',team='team_On1DNBSQbtQtgipToHCIY4pk';
const rows=[],seen=new Set();let until=end,pages=0;
for(;pages<20;){
  const url=`/v6/deployments?${ownerWindow?'':`projectId=${project}&`}teamId=${team}&limit=100&since=${since}&until=${until}`;
  const raw=execFileSync('vercel',['api',url,'--method','GET','--raw'],{encoding:'utf8',maxBuffer:60000000,stdio:['ignore','pipe','pipe']});
  const response=JSON.parse(raw);pages++;
  for(const d of response.deployments||[]){
    if(seen.has(d.uid))continue;seen.add(d.uid);
    const ms=d.created??d.createdAt;if(!(ms>=since&&ms<end))continue;
    const sha=d.meta?.githubCommitSha;let paths=null;
    if(!ownerWindow&&/^[a-f0-9]{40}$/.test(sha||''))try{paths=execFileSync('git',['diff','--name-only',sha+'^',sha],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim().split('\n').filter(Boolean);}catch{}
    rows.push({id:d.uid,project:d.name,at:new Date(ms).toISOString(),ist:new Date(ms+19800000).toISOString().replace('Z',' IST'),
      state:d.readyState??d.state,target:d.target??'preview',branch:d.meta?.githubCommitRef??null,sha:sha??null,
      message:d.meta?.githubCommitMessage??null,paths,
      dataOnly:paths?.length?paths.every(p=>p.startsWith('data/')||p==='research/universe.json'):null,
      url:'https://'+d.url});
  }
  const next=response.pagination?.next;
  if(!next||next<=since||next>=until)break;until=next;
}
const tally=key=>rows.reduce((a,r)=>{const k=String(key(r));a[k]=(a[k]||0)+1;return a;},{});
console.log(JSON.stringify({date,timeZone:'Asia/Kolkata',generatedAt:new Date().toISOString(),pages,
  window:{since:new Date(since).toISOString(),until:new Date(end).toISOString(),scope:ownerWindow?'rolling owner':'IST project day'},
  total:rows.length,states:tally(r=>r.state),targets:tally(r=>r.target),dataOnly:tally(r=>r.dataOnly),
  byProject:tally(r=>r.project),byHourIST:tally(r=>r.ist.slice(11,13)+':00'),deployments:ownerWindow?undefined:rows,
  limitations:['Counts created deployments for this project in this IST calendar day, not every project or the entire rolling owner window.',
    'Rate-rejected attempts with no deployment object are not included. Unknown Git commits are not guessed.']},null,2));
