import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import {exportTaskState,importTaskState} from './task-handoff.mjs'
const pure=()=>Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>p+' ok']))
// fixture() sets process-wide sandbox env; pin each pair member to its own root so two can coexist.
const own=async()=>{const f=await fixture(),L=f.lease
 return {...f,lease:{...L,fenced:(h,t,cb,o={})=>L.fenced(h,t,cb,{...o,sandbox:f.root}),acquire:(h,o={})=>L.acquire(h,{...o,sandbox:f.root}),renew:(h,t,o={})=>L.renew(h,t,{...o,sandbox:f.root})}}}
const wait=async fn=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('timeout')}
test('handoff carries partial progress; target resumes from last confirmed phase, once, and arrives resting',async()=>{
 const a=await own(),b=await own();let sa,sb,release,started=false
 try{
  const h=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>{if(p==='plan'){started=true;return new Promise(r=>{release=r})}return p+' ok'}]))
  sa=createTaskCheckpoints({...a,toolPolicy:'read-only',handlers:h,budget:12});sa.enqueue({id:'t1',input:'goal',units:1});await sa.setRest(false,{op:'wake'});await wait(()=>started)
  const pause=sa.setRest(true,{op:'sleep'});release('discard');await pause
  assert.equal(sa.status().tasks[0].phase,2)
  const bundle=exportTaskState(a.lease,'local',a.term)
  sb=createTaskCheckpoints({...b,toolPolicy:'read-only',handlers:pure(),budget:12})
  const dry=importTaskState(b.lease,'local',b.term,bundle,{op:'h1',dryRun:true});assert.equal(dry.dryRun,true);assert.equal(sb.status().tasks.length,0)
  importTaskState(b.lease,'local',b.term,bundle,{op:'h1'})
  assert.equal(sb.status().control.rest,1);assert.equal(sb.status().tasks[0].phase,2)
  assert.equal(importTaskState(b.lease,'local',b.term,bundle,{op:'h1'}).replayed,true)
  await sb.setRest(false,{op:'resume'});await sb.idle()
  const s=sb.status();assert.equal(s.tasks[0].state,'done');assert.equal(s.tasks[0].phase,4);assert.equal(s.control.spent,bundle.control.spent+2)
 }finally{if(sa)await sa.close();if(sb)await sb.close();a.cleanup();b.cleanup()}
})
test('export refuses while awake; import refuses tampering and stale term; same state under new op is idempotent',async()=>{
 const a=await own(),b=await own();let sa,sb
 try{
  sa=createTaskCheckpoints({...a,toolPolicy:'read-only',handlers:pure(),budget:12});sa.enqueue({id:'t1',input:'g',units:1})
  await sa.setRest(false,{op:'wake'});await sa.idle()
  assert.throws(()=>exportTaskState(a.lease,'local',a.term),/resting/)
  await sa.setRest(true,{op:'sleep'});const bundle=exportTaskState(a.lease,'local',a.term)
  sb=createTaskCheckpoints({...b,toolPolicy:'read-only',handlers:pure(),budget:12})
  assert.throws(()=>importTaskState(b.lease,'local',b.term,{...bundle,tasks:[]},{op:'x'}),/digest/)
  assert.throws(()=>importTaskState(b.lease,'local',b.term+1,bundle,{op:'y'}),/FENCED/)
  importTaskState(b.lease,'local',b.term,bundle,{op:'h1'})
  assert.equal(importTaskState(b.lease,'local',b.term,bundle,{op:'h2'}).imported,0)
  assert.throws(()=>importTaskState(b.lease,'local',b.term,{...bundle,digest:'0'.repeat(64)},{op:'h1'}),/digest/)
 }finally{if(sa)await sa.close();if(sb)await sb.close();a.cleanup();b.cleanup()}
})
test('target that moved ahead or diverged is never overwritten',async()=>{
 const a=await own(),b=await own(),c=await own();let sa,sb,sc
 try{
  sa=createTaskCheckpoints({...a,toolPolicy:'read-only',handlers:pure(),budget:12});sa.enqueue({id:'t1',input:'g',units:1});await sa.setRest(true,{op:'s'})
  const old=exportTaskState(a.lease,'local',a.term)
  sa.enqueue({id:'t2',input:'g2',units:1});const newer=exportTaskState(a.lease,'local',a.term)
  sb=createTaskCheckpoints({...b,toolPolicy:'read-only',handlers:pure(),budget:12})
  importTaskState(b.lease,'local',b.term,newer,{op:'n1'})
  assert.throws(()=>importTaskState(b.lease,'local',b.term,old,{op:'o1'}),/newer/)
  sc=createTaskCheckpoints({...c,toolPolicy:'read-only',handlers:pure(),budget:12});sc.enqueue({id:'z',input:'other',units:1});await sc.setRest(true,{op:'s'})
  assert.throws(()=>importTaskState(c.lease,'local',c.term,newer,{op:'d1'}),/diverged/)
 }finally{for(const s of [sa,sb,sc])if(s)await s.close();a.cleanup();b.cleanup();c.cleanup()}
})
