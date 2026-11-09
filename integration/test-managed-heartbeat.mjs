import test from 'node:test'
import assert from 'node:assert/strict'
import {aurabotHost} from './aurabot-host-fixture.mjs'
import {createManagedHeartbeat} from './managed-heartbeat.mjs'
const config=()=>({enabled:true,intervalSeconds:30,pauseAfterMissed:3,compactBeforeBeat:false,awakeSeconds:0,prompt:'SYNTHETIC HEARTBEAT'})
const options=()=>({readConfig:config,legacyDetached:true})
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('condition did not become true')}

test('original heartbeat runtime follows shared rest and wakes original agent through one managed outbox',async()=>{
 const f=await aurabotHost({heartbeat:options()});try{
  assert.equal((await f.handle.heartbeat.tick()).skipped,'rest');assert.equal(f.requests.length,0);assert.equal(f.handle.heartbeat.runtime.missedCount,0)
  await f.supervisor.setRest(false,{op:'wake'})
  assert.equal((await f.handle.heartbeat.tick()).state,'done');assert.equal(f.requests.length,1);assert.equal(f.sent.length,0)
  assert.equal(f.handle.heartbeat.runtime.missedCount,1);assert.equal(f.supervisor.status().control.spent,1)
  assert.equal(f.agent.session.snapshotEvents().find(e=>e.type==='user/message').data.source.origin,'module-event')
  await f.supervisor.setRest(true,{op:'sleep'});assert.equal((await f.handle.heartbeat.tick()).skipped,'rest');assert.equal(f.requests.length,1)
 }finally{await f.cleanup()}
})

test('heartbeat missed pause and real QQ-user reset preserve original policy; stay beat does not increase misses',async()=>{
 const f=await aurabotHost({heartbeat:options()});try{
  await f.supervisor.setRest(false,{op:'wake'})
  await f.handle.heartbeat.tick();await f.handle.heartbeat.stayTick();assert.equal(f.handle.heartbeat.runtime.missedCount,1)
  await f.handle.heartbeat.tick();await f.handle.heartbeat.tick();assert.equal(f.requests.length,4)
  await f.handle.heartbeat.tick();assert.equal(f.handle.heartbeat.runtime.paused,true);assert.equal(f.requests.length,4)
  await f.emit(f.event(9101,'SYNTHETIC OWNER'));await f.settle(1)
  assert.equal(f.handle.heartbeat.runtime.missedCount,0);assert.equal(f.handle.heartbeat.runtime.paused,false)
 }finally{await f.cleanup()}
})

test('rest cancels heartbeat-owned native model request and waits for actual turn end',async()=>{
 const f=await aurabotHost({mode:'wait-abort',heartbeat:options()});try{
  await f.supervisor.setRest(false,{op:'wake'});const running=f.handle.heartbeat.tick();await waitFor(()=>f.requests.length===1)
  const result=await f.supervisor.setRest(true,{op:'sleep'});assert.equal(result.drained,true)
  assert.equal((await running).state,'needs_review');assert.equal(f.agent.status,'idle');assert.equal(f.sent.length,0)
 }finally{await f.cleanup()}
})

test('heartbeat and module wake do not run two autonomous turns concurrently on original agent',async()=>{
 const def={id:'parallel-test',setup(api){api.every(60000,()=>api.core.hub.pushToSession({chatId:'private:20001',kind:'private',userId:'20001'},[{type:'text',text:'SYNTHETIC MODULE'}],''));return {}}}
 const f=await aurabotHost({mode:'wait-abort',builtins:[def],heartbeat:options()});try{
  await f.supervisor.setRest(false,{op:'wake'});const running=f.handle.heartbeat.tick();await waitFor(()=>f.requests.length===1)
  const other=f.activityCallbacks.find(r=>r.moduleId==='parallel-test').run
  // The existing original-session busy check refuses a second model turn.
  assert.equal((await other()).skipped,'busy');await f.supervisor.setRest(true,{op:'sleep'});await running
  assert.equal(f.requests.length,1);assert.equal(f.sent.length,0)
 }finally{await f.cleanup()}
})

test('rest gate runs before heartbeat compaction; no history side work while resting',async()=>{
 let compactions=0
 const f=await aurabotHost({activityUnits:2,heartbeat:{...options(),readConfig:()=>({...config(),compactBeforeBeat:true}),getCompaction:()=>({compactNow:async()=>{compactions++;return true}})}})
 try{
  await f.handle.heartbeat.tick();assert.equal(compactions,0)
  await f.supervisor.setRest(false,{op:'wake'});await f.handle.heartbeat.tick();assert.equal(compactions,1);assert.equal(f.sent.length,0)
 }finally{await f.cleanup()}
})

test('host exit disposes heartbeat timer, stay timers and inbox listener; no stale tick executes',async()=>{
 const f=await aurabotHost({heartbeat:options()});try{
  const runtime=f.handle.heartbeat.runtime;runtime.scheduleStayAwake({...config(),awakeSeconds:60,awakeBeatSeconds:30})
  assert.ok(runtime.stayTimers.length>0);await f.unmount()
  assert.equal(runtime.disposed,true);assert.equal(runtime.timer,undefined);assert.equal(runtime.stayTimers.length,0);assert.equal(runtime.stopInserted,undefined)
  await assert.rejects(f.handle.heartbeat.tick(),/host stopped|heartbeat disposed/);assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})

test('managed heartbeat refuses missing legacy handoff instead of attaching a second producer',()=>{
 assert.throws(()=>createManagedHeartbeat({legacyDetached:false}),/handoff/)
})

test('repeated heartbeat start preserves one inbox subscription and rest skip re-arms only control timer',async()=>{
 const f=await aurabotHost({heartbeat:options()});try{
  const runtime=f.handle.heartbeat.runtime,subscription=runtime.stopInserted
  f.handle.heartbeat.start();f.handle.heartbeat.start();assert.equal(runtime.stopInserted,subscription)
  runtime.clearTimer();assert.equal(runtime.timer,undefined)
  assert.equal((await f.handle.heartbeat.tick()).skipped,'rest');assert.ok(runtime.timer)
  assert.equal(f.requests.length,0);assert.equal(f.supervisor.status().control.spent,0)
 }finally{await f.cleanup()}
})
