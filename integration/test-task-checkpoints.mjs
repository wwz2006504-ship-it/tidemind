import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
const pure=()=>Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>p+' complete']))
test('default rest stores queued task; event-driven resume completes four checkpoints and bounded budget',async()=>{
 const f=await fixture();let s
 try{s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:pure(),budget:8});s.enqueue({id:'a',input:'synthetic',units:1});await s.idle();assert.equal(s.status().tasks[0].phase,0)
  await s.setRest(false,{op:'wake'});await s.idle();const state=s.status();assert.equal(state.tasks[0].state,'done');assert.equal(state.tasks[0].phase,4);assert.equal(state.control.spent,4)
  assert.equal(s.enqueue({id:'a',input:'synthetic',units:1}).replayed,true);await s.idle();assert.equal(s.status().control.spent,4)
 }finally{if(s)await s.close();f.cleanup()}
})
import {controllerHost} from './controller-host.mjs'
import {createCognitiveDriver} from './cognitive-driver.mjs'
import {join} from 'node:path'
test('four phases run through a dedicated real Controller/AgentLoop session, with no memory write or QQ capability',async()=>{
 const f=await controllerHost();let s
 try{
  const before=f.gateway.head(f.lease).revision,driver=await createCognitiveDriver({toolPolicy:'read-only',ctx:f.ctx,controller:f.controller,sessionId:'tidemind-cognitive-isolated',cwd:join(f.root,'cognitive')})
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,driver.handle])),budget:8})
  s.enqueue({id:'native',input:'合成观察任务',units:1});await s.setRest(false,{op:'wake'});await s.idle()
  assert.equal(s.status().tasks[0].state,'done');assert.equal(f.requests.length,4);assert.deepEqual(f.errors,[])
  assert.ok(f.requests.every(r=>r.maxTokens===128&&(!r.tools||r.tools.length===0)))
  assert.equal(f.gateway.head(f.lease).revision,before)
 }finally{if(s)await s.close();await f.cleanup()}
})
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('condition did not become true')}
test('rest aborts an actual running native model request and waits for real loop idle; no later stage runs',async()=>{
 const f=await controllerHost({mode:'wait-abort'});let s
 try{
  const driver=await createCognitiveDriver({toolPolicy:'read-only',ctx:f.ctx,controller:f.controller,sessionId:'tidemind-cognitive-cancel',cwd:join(f.root,'cognitive')})
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,driver.handle])),budget:8})
  s.enqueue({id:'cancel-native',input:'合成等待',units:1});await s.setRest(false,{op:'wake'});await waitFor(()=>f.requests.length===1)
  const paused=await s.setRest(true,{op:'sleep'});assert.equal(paused.drained,true);assert.equal(driver.agent.status,'idle');assert.equal(s.status().tasks[0].state,'paused')
  s.enqueue({id:'still-resting',input:'合成排队',units:1});await s.idle();assert.equal(f.requests.length,1);assert.equal(s.status().control.rest,1)
 }finally{if(s)await s.close();await f.cleanup()}
})
test('non-cooperative handler cannot receive a premature stopped acknowledgement or advance checkpoint',async()=>{
 const f=await fixture();let s,release,started=false,ack=false
 try{
  const h=pure();h.observe=()=>{started=true;return new Promise(r=>{release=r})}
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:h,budget:8});s.enqueue({id:'stubborn',input:'synthetic',units:1});await s.setRest(false,{op:'wake'});await waitFor(()=>started)
  const stopping=s.setRest(true,{op:'sleep'}).then(r=>{ack=true;return r});await Promise.resolve();assert.equal(ack,false);assert.equal(s.status().stopping,true)
  release('late output');const result=await stopping;assert.equal(result.drained,true);assert.equal(s.status().tasks[0].phase,0);assert.equal(s.status().tasks[0].state,'paused')
 }finally{if(s)await s.close();f.cleanup()}
})
test('paused checkpoint and rest survive reconstruction; explicit resume starts from last confirmed phase',async()=>{
 const f=await fixture();let s,release,started=false;const calls=[]
 try{
  const h=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>{calls.push(p);if(p==='reflect'){started=true;return new Promise(r=>{release=r})}return p}]))
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:h,budget:12});s.enqueue({id:'checkpoint',input:'synthetic',units:1});await s.setRest(false,{op:'wake'});await waitFor(()=>started)
  const pause=s.setRest(true,{op:'sleep'});release('discard');await pause;assert.equal(s.status().tasks[0].phase,1);await s.close()
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:pure(),budget:12});await s.start();assert.equal(s.status().control.rest,1);assert.equal(s.status().tasks[0].phase,1)
  await s.setRest(false,{op:'resume'});await s.idle();assert.equal(s.status().tasks[0].state,'done');assert.equal(s.status().control.spent,5)
 }finally{if(s)await s.close();f.cleanup()}
})
test('budget persists and blocks further phases without a refund after cancellation',async()=>{
 const f=await fixture();let s
 try{s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:pure(),budget:2});s.enqueue({id:'limited',input:'synthetic',units:1});await s.setRest(false,{op:'wake'});await s.idle()
  assert.equal(s.status().tasks[0].phase,2);assert.equal(s.status().tasks[0].state,'blocked_budget');assert.equal(s.status().control.spent,2)
  await s.close();s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:pure(),budget:2});assert.equal(s.status().control.spent,2)
 }finally{if(s)await s.close();f.cleanup()}
})
test('dry-run and replayed operations have no new task or state effects; conflicting IDs and capability grants rejected',async()=>{
 const f=await fixture();let s
 try{s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:pure(),budget:8});const before=s.status().control.revision
  s.enqueue({id:'preview',input:'synthetic',units:1},{dryRun:true});await s.setRest(false,{op:'preview',dryRun:true});assert.equal(s.status().tasks.length,0);assert.equal(s.status().control.revision,before)
  await s.setRest(true,{op:'sleep'});const revision=s.status().control.revision;await s.setRest(true,{op:'sleep'});assert.equal(s.status().control.revision,revision)
  await assert.rejects(s.setRest(false,{op:'sleep'}),/conflict/)
  assert.throws(()=>s.enqueue({id:'unsafe',input:'text',units:1,permissions:['desktop']}),/capability/)
  s.enqueue({id:'same',input:'a',units:1});assert.throws(()=>s.enqueue({id:'same',input:'b',units:1}),/conflict/)
 }finally{if(s)await s.close();f.cleanup()}
})
test('opt-in read-only cognitive scope cannot commit original memory tools or render/send a borrowed QQ reply',async()=>{
 const f=await controllerHost();let s
 try{
  const results=[],before=f.gateway.head(f.lease).revision
  const h=pure();h.observe=async()=>{const out=await f.ctx.tools.execute({name:'lmem_write',arguments:{layer:'semantic',content:'不应提交的主动任务'},callId:'proactive-write',agent:f.agent,signal:new AbortController().signal});results.push(out);return 'blocked'}
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:h,budget:8});s.enqueue({id:'no-write',input:'synthetic',units:1});await s.setRest(false,{op:'wake'});await s.idle()
  assert.equal(results[0].isError,true);assert.equal(f.gateway.head(f.lease).revision,before)
  assert.equal(f.read("SELECT count(*) n FROM memories WHERE content='不应提交的主动任务'")[0].n,0)
 }finally{if(s)await s.close();await f.cleanup()}
})
import {qqFixture} from './qq-fixture.mjs'
test('opt-in read-only cognitive scope denies borrowed QQ reply before renderer and transport',async()=>{
 const f=await qqFixture();let s,rendered=0
 try{
  const binding=f.bind([f.event('2001')]),h=pure();h.observe=async()=>{await assert.rejects(f.outbound.reply(binding,async()=>{rendered++;return {}}),/no write or send permission/);return 'blocked'}
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:h,budget:8});s.enqueue({id:'no-qq',input:'synthetic',units:1});await s.setRest(false,{op:'wake'});await s.idle();assert.equal(rendered,0);assert.equal(f.sent.length,0)
 }finally{if(s)await s.close();await f.cleanup()}
})
test('native model cannot bypass reserved request budget by repeatedly requesting tools',async()=>{
 const f=await controllerHost({mode:'core-attempt'});let s
 try{
  const driver=await createCognitiveDriver({toolPolicy:'read-only',ctx:f.ctx,controller:f.controller,sessionId:'tidemind-cognitive-budget',cwd:join(f.root,'cognitive')})
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,driver.handle])),budget:8})
  s.enqueue({id:'model-loop',input:'synthetic',units:1});await s.setRest(false,{op:'wake'});await s.idle()
  assert.equal(f.requests.length,1);assert.equal(s.status().tasks[0].state,'failed');assert.equal(s.status().control.spent,1)
  assert.equal(f.read("SELECT count(*) n FROM memories WHERE content='不允许覆盖身份'")[0].n,0)
 }finally{if(s)await s.close();await f.cleanup()}
})
test('new term marks interrupted running phase for review and never automatically reruns it',async()=>{
 const f=await fixture();let old,fresh,release,started=false
 try{
  const h=pure();h.observe=()=>{started=true;return new Promise(r=>{release=r})}
  old=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:h,budget:8});old.enqueue({id:'interrupted',input:'synthetic',units:1});await old.setRest(false,{op:'wake'});await waitFor(()=>started)
  f.lease.release('local',f.term);const term=f.lease.acquire('local').term
  fresh=createTaskCheckpoints({...f,toolPolicy:'read-only',term,handlers:pure(),budget:8});assert.equal(fresh.status().tasks[0].state,'needs_review')
  release('old output');await assert.rejects(old.idle(),/FENCED/);await fresh.start();assert.equal(fresh.status().tasks[0].phase,0);assert.equal(fresh.status().control.spent,1)
 }finally{if(fresh)await fresh.close();if(old)await assert.rejects(old.close(),/FENCED/);f.cleanup()}
})

test('replaying an old rest operation after a newer resume does not cancel current work',async()=>{
 const f=await fixture();let s,release,started=false,signal
 try{
  const h=pure();h.observe=c=>{started=true;signal=c.signal;return new Promise(r=>{release=r})}
  s=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:h,budget:8});await s.setRest(true,{op:'old-rest'});s.enqueue({id:'active',input:'text',units:1});await s.setRest(false,{op:'new-resume'});await waitFor(()=>started)
  const replay=await s.setRest(true,{op:'old-rest'});assert.equal(replay.replayed,true);assert.equal(signal.aborted,false);assert.equal(s.status().control.rest,0)
  release('observed');await s.idle();assert.equal(s.status().tasks[0].state,'done')
 }finally{if(s)await s.close();f.cleanup()}
})
