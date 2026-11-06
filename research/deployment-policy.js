// Code releases are explicit; mutable JSON commits must never create deployments.
export const VERCEL_PROJECT_ID='prj_Tlfw4In0eSsMIogUU80JGUgrDKfr';
export function isMutableMarketPath(path){return typeof path==='string'&&(path.startsWith('data/')||path==='research/universe.json');}
export function releasePreflight({mode,head,originMain,dirty,projectId}={}){
  const reasons=[];
  if(!['production','preview'].includes(mode))reasons.push('explicit production or preview target required');
  if(!/^[a-f0-9]{40}$/.test(head||''))reasons.push('valid source commit required');
  if(dirty)reasons.push('commit or preserve local changes before releasing');
  if(projectId!==VERCEL_PROJECT_ID)reasons.push('wrong or unlinked Vercel project');
  if(mode==='production'&&head!==originMain)reasons.push('production must use the fetched main commit; synchronize this checkout first');
  return {ready:reasons.length===0,reasons,mode,sourceCommit:head??null,automaticGitDeployments:false};
}
