import test from 'node:test'
import assert from 'node:assert/strict'
import {qqFixture} from './qq-fixture.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import {createModuleActivity} from './module-activity.mjs'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
import {aurabotHost} from './aurabot-host-fixture.mjs'
const handlers=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>p]))
const waitFor=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}throw Error('condition did not become true')}

test('module callbacks share persisted rest and budget; existing tools execute autonomously only during active callback',async()=>{
 const f=await qqFixture();let s
 try{
  let calls=0,runs=0;const c=createOneBotCapabilities({...f,selfId:10001,allowTargets:['private:20001'],transport:async()=>{calls++;return {}}})
  s=createTaskCheckpoints({...f,handlers,budget:1})
  const bridge=createModuleActivity({supervisor:s,capabilities:c,agent:f.agent})
  const run=bridge.wrap(async()=>{runs++;await c.moduleClient.call('set_essence_msg',{message_id:1})},{moduleId:'test-module',label:'synthetic',guard(){}})
  assert.equal((await run()).skipped,'rest');assert.equal(runs,0)
  await s.setRest(false,{op:'wake'})
  assert.equal((await run()).state,'done');assert.equal(calls,1)
  assert.equal((await run()).skipped,'budget');assert.equal(runs,1);assert.equal(s.status().control.spent,1)
 }finally{if(s)await s.close();await f.cleanup()}
})

test('rest waits for non-cooperative callback and rejects its delayed Hub call',async()=>{
 const f=await qqFixture();let s,release;let started=false,stopped=false,sideEffects=0
 try{
  const c=createOneBotCapabilities({...f,selfId:10001,allowTargets:['private:20001'],transport:async()=>assert.fail()})
  s=createTaskCheckpoints({...f,handlers,budget:2});await s.setRest(false,{op:'wake'})
  const bridge=createModuleActivity({supervisor:s,capabilities:c,agent:f.agent}),core=bridge.protectCore({hub:{pushToSession(){sideEffects++}}})
  const pending=bridge.wrap(async()=>{started=true;await new Promise(r=>{release=r});core.hub.pushToSession()},{moduleId:'test-wait',label:'synthetic',guard(){}})()
  await waitFor(()=>started)
  const stopping=s.setRest(true,{op:'sleep'}).then(r=>{stopped=true;return r})
  await Promise.resolve();assert.equal(stopped,false);assert.equal(s.status().stopping,true)
  release();assert.equal((await pending).state,'needs_review');assert.equal((await stopping).drained,true)
  assert.equal(sideEffects,0)
 }finally{release?.();if(s)await s.close();await f.cleanup()}
})

test('module activity IDs cannot replay callbacks or be rebound to different work',async()=>{
 const f=await qqFixture();let s;let calls=0
 try{
  s=createTaskCheckpoints({...f,handlers,budget:4});await s.setRest(false,{op:'wake'})
  const task={id:'module:test:stable',input:'synthetic',units:1}
  assert.equal((await s.runActivity(task,async()=>{calls++})).state,'done')
  assert.equal((await s.runActivity(task,async()=>{calls++})).replayed,true)
  await assert.rejects(s.runActivity({...task,input:'changed'},async()=>{}),/conflict/)
  assert.equal(calls,1);assert.equal(s.status().control.spent,1)
 }finally{if(s)await s.close();await f.cleanup()}
})

test('actual isolated host module delay follows shared rest; resume and reload executes without consent prompt',async()=>{
 let count=0
 const def={id:'activity-test',setup(api){api.later(10,async()=>{count++;await api.onebot('set_essence_msg',{message_id:42})});return {}}}
 const f=await aurabotHost({builtins:[def]})
 try{
  await new Promise(r=>setTimeout(r,40));assert.equal(count,0);assert.equal(f.calls.length,0)
  await f.supervisor.setRest(false,{op:'wake'});await f.handle.modules.reload(def.id)
  await waitFor(()=>f.calls.length===1);await f.supervisor.idle()
  assert.equal(count,1);assert.equal(f.supervisor.status().control.spent,1)
  assert.equal(f.supervisor.status().tasks[0].state,'done')
 }finally{await f.cleanup()}
})

test('actual host blocks a delayed wake after rest and does not claim drained until callback exits',async()=>{
 let entered=false,release
 const def={id:'waiting-test',setup(api){api.later(10,async()=>{entered=true;await new Promise(r=>{release=r});await api.core.hub.pushToSession({chatId:'private:20001',kind:'private',userId:'20001'},[{type:'text',text:'SYNTHETIC WAKE'}],'')});return {}}}
 const f=await aurabotHost({builtins:[def]})
 try{
  await f.supervisor.setRest(false,{op:'wake'});await waitFor(()=>entered)
  let done=false;const stopping=f.supervisor.setRest(true,{op:'sleep'}).then(r=>{done=true;return r})
  await Promise.resolve();assert.equal(done,false);release()
  assert.equal((await stopping).drained,true);assert.equal(f.requests.length,0);assert.equal(f.sent.length,0)
 }finally{release?.();await f.cleanup()}
})

test('managed original Hub wake completes on original native agent, journals module provenance and sends one bound reply',async()=>{
 const def={id:'wake-test',setup(api){api.later(20,()=>api.core.hub.pushToSession({chatId:'private:20001',kind:'private',userId:'20001'},[{type:'text',text:'SYNTHETIC 自主任务 我喜欢不应自动记忆的项目'}],''));return {}}}
 const f=await aurabotHost({builtins:[def]})
 try{
  const memoryRevision=f.gateway.head(f.lease).revision
  await f.supervisor.setRest(false,{op:'wake'});await waitFor(()=>f.requests.length===1);await f.supervisor.idle()
  assert.equal(f.supervisor.status().tasks[0].state,'done');assert.equal(f.agent.status,'idle');assert.equal(f.sent.length,1,JSON.stringify(f.handle.logger.recent(50)))
  assert.equal(f.gateway.head(f.lease).revision,memoryRevision)
  const input=f.agent.session.snapshotEvents().find(e=>e.type==='user/message');assert.equal(input.data.source.origin,'module-event')
  assert.equal(f.requests[0].maxTokens,128)
 }finally{await f.cleanup()}
})

test('rest cancels a module-owned actual native turn and waits idle, without posting QQ or advancing another model request',async()=>{
 const def={id:'sleep-test',setup(api){api.later(20,()=>api.core.hub.pushToSession({chatId:'private:20001',kind:'private',userId:'20001'},[{type:'text',text:'SYNTHETIC WAIT'}],''));return {}}}
 const f=await aurabotHost({mode:'wait-abort',builtins:[def]})
 try{
  await f.supervisor.setRest(false,{op:'wake'});await waitFor(()=>f.requests.length===1)
  const stopped=await f.supervisor.setRest(true,{op:'sleep'})
  assert.equal(stopped.drained,true);assert.equal(f.agent.status,'idle');assert.equal(f.sent.length,0);assert.equal(f.requests.length,1)
  assert.equal(f.supervisor.status().tasks[0].state,'needs_review')
 }finally{await f.cleanup()}
})

test('module provenance cannot be submitted as a QQ user; module reply still uses one deduplicated outbox slot',async()=>{
 const f=await qqFixture();try{
  const content=[{type:'text',text:'SYNTHETIC MODULE'}],chatId='private:20001'
  const event={id:'module:test:event',moduleId:'test-module',chatId,content}
  const r=f.outbound.observeAutonomous(event);assert.equal(f.outbound.observeAutonomous(event).admitted,false)
  let calls=0,message
  const admission={sessionId:f.agent.id,chatId,origins:[r.origin],content,followup:async m=>{calls++;message=m},flush:async()=>{}}
  await assert.rejects(f.outbound.admitInput(admission),/source mismatch/);assert.equal(calls,0)
  await f.outbound.admitInput({...admission,sourceOrigin:'module-event'});assert.equal(message.source.origin,'module-event')
  f.outbound.bindTurn({sessionId:f.agent.id,turn:1,chatId,origins:[r.origin]})
  await f.outbound.reply({sessionId:f.agent.id,turn:1,chatId},f.render(chatId,'SYNTHETIC RESULT'))
  await f.outbound.reply({sessionId:f.agent.id,turn:1,chatId},f.render(chatId,'SYNTHETIC RESULT'))
  assert.equal(f.sent.length,1)
 }finally{await f.cleanup()}
})

test('module native turn cannot exceed its reserved request count through a tool loop',async()=>{
 const def={id:'budget-test',setup(api){api.later(20,()=>api.core.hub.pushToSession({chatId:'private:20001',kind:'private',userId:'20001'},[{type:'text',text:'SYNTHETIC WORK'}],''));return {}}}
 const f=await aurabotHost({mode:'work-tool',builtins:[def]})
 let calls=0;const off=f.ctx.tools.register({name:'work_marker',description:'synthetic work',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[{type:'text',text:'done'}]},execute:async()=>{calls++;return {ok:true}}})
 try{
  await f.supervisor.setRest(false,{op:'wake'});await waitFor(()=>f.requests.length===1);await f.supervisor.idle()
  assert.equal(f.requests.length,1);assert.equal(calls,1);assert.equal(f.sent.length,0)
  assert.equal(f.supervisor.status().tasks[0].state,'needs_review')
 }finally{off();await f.cleanup()}
})

test('owner message interrupts managed module turn first, then normal chat keeps its independent memory and reply path',async()=>{
 const def={id:'interrupt-test',setup(api){api.later(20,()=>api.core.hub.pushToSession({chatId:'private:20001',kind:'private',userId:'20001'},[{type:'text',text:'SYNTHETIC WAIT'}],''));return {}}}
 const f=await aurabotHost({mode:'wait-first-abort',builtins:[def]})
 try{
  await f.supervisor.setRest(false,{op:'wake'});await waitFor(()=>f.requests.length===1)
  await f.emit(f.event(8101,'麦克风 我喜欢合成蓝色风铃'));await f.settle()
  assert.equal(f.requests.length,2);assert.equal(f.sent.length,1)
  assert.ok(f.read("SELECT id FROM memories WHERE content LIKE '%蓝色风铃%'").length>0)
  assert.equal(f.supervisor.status().tasks[0].state,'needs_review')
 }finally{await f.cleanup()}
})

test('unmanaged followup cannot borrow the previous QQ input to send a new reply',async()=>{
 const f=await aurabotHost();try{
  await f.emit(f.event(8201,'SYNTHETIC OWNER'));await f.settle()
  f.agent.followup({id:'unmanaged-test',role:'user',content:[{type:'text',text:'SYNTHETIC UNMANAGED'}],source:{kind:'plugin'}})
  await waitFor(()=>f.requests.length===2&&f.agent.status==='idle')
  await f.unmount();assert.equal(f.sent.length,1)
 }finally{await f.cleanup()}
})
