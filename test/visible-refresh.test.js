import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleRefresh} from '../desk/visible-refresh.js';
test('visible UI refresh pauses in hidden tabs, resumes, coalesces requests, and cleans up',async()=>{
  let callback, resume, calls=0, release, cleared=false;
  const doc={hidden:true,addEventListener:(name,fn)=>{assert.equal(name,'visibilitychange');resume=fn;},removeEventListener:()=>{resume=null;}};
  const win={setInterval:(fn,delay)=>{callback=fn;assert.equal(delay,60000);return 1;},clearInterval:()=>{cleared=true;}};
  const stop=visibleRefresh({doc,win,refresh:async()=>{calls++;await new Promise(r=>release=r);}});
  callback();assert.equal(calls,0);doc.hidden=false;resume();assert.equal(calls,1);
  callback();resume();assert.equal(calls,1);release();await new Promise(r=>setImmediate(r));
  callback();assert.equal(calls,2);release();await new Promise(r=>setImmediate(r));
  stop();assert.equal(cleared,true);assert.equal(resume,null);callback();assert.equal(calls,2);
});
