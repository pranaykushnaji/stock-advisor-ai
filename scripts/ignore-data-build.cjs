// Defense in depth only: canceled builds STILL consume deployment quota.
// Automatic Git deployments are disabled in project settings and vercel.json.
// Vercel: zero skips, one builds. Missing metadata/history must build.
const {spawnSync}=require('node:child_process');
const previous=process.env.VERCEL_GIT_PREVIOUS_SHA;
if(!/^[a-f0-9]{40}$/.test(previous||''))process.exit(1);
const r=spawnSync('git',['diff','--name-only',previous,'HEAD'],{encoding:'utf8'});
if(r.status!==0)process.exit(1);
const files=r.stdout.trim().split('\n').filter(Boolean);
process.exit(files.every(p=>p.startsWith('data/')||p==='research/universe.json')?0:1);
