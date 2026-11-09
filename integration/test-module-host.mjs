import test from 'node:test'
import assert from 'node:assert/strict'
import {createModules} from '../host/aurabot/src/core/modules.js'
import groupAdmin from '../host/aurabot/src/modules/group-admin/index.js'
import {createGroupRoles} from '../host/aurabot/src/chat/group-roles.js'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
import {qqFixture} from './qq-fixture.mjs'

test('async module disposal remains visible after stop and blocks replacement until released',async()=>{
 let release,starts=0;const definition={id:'cleanup-test',setup(){starts++;return {dispose:()=>new Promise(r=>release=r)}}},h=await fixture(definition)
 try{h.mods.stop(definition.id);assert.equal(h.mods.transferStatus().lifecycle.active,1);const reloading=h.mods.reload(definition.id);await new Promise(r=>setTimeout(r,10));assert.equal(starts,1);release();await reloading;assert.equal(starts,2);assert.equal(h.mods.transferStatus().lifecycle.active,0)}finally{h.mods.dispose();release?.();await h.mods.drainLifecycle();await h.cleanup()}
})

test('rejected module cleanup prevents reload and is retained for review',async()=>{
 let starts=0;const definition={id:'bad-cleanup',setup(){starts++;return {dispose:async()=>{throw Error('synthetic cleanup failure')}}}},h=await fixture(definition)
 try{h.mods.stop(definition.id);await assert.rejects(h.mods.reload(definition.id),/requires review/);assert.equal(starts,1);assert.equal(h.mods.transferStatus().lifecycle.failures,1)}finally{await h.cleanup()}
})

test('dispose records async cleanup without resurrecting a stopped module',async()=>{
 let release;const h=await fixture({id:'exit-cleanup',setup(){return {dispose:()=>new Promise(r=>release=r)}}})
 try{h.mods.dispose();h.mods.dispose();assert.equal(h.mods.transferStatus().lifecycle.active,1);await assert.rejects(h.mods.drainLifecycle({timeoutMs:10}),/timed out/);release();await h.mods.drainLifecycle();await h.mods.sync();assert.equal(h.mods.running('exit-cleanup'),null)}finally{release?.();await h.cleanup()}
})

test('original module emit tracks async work even though emit returns immediately',async()=>{
 let release,entered=false;const h=await fixture({id:'drain-test',name:'synthetic',setup(api){api.on('synthetic-wait',async()=>{entered=true;await new Promise(r=>release=r)})}})
 try{h.mods.emit('synthetic-wait');assert.equal(entered,true);assert.equal(h.mods.transferStatus().active,1);await assert.rejects(h.mods.drainCallbacks({timeoutMs:10}),/timed out/);release();await h.mods.drainCallbacks();assert.equal(h.mods.transferStatus().active,0);assert.equal(h.mods.transferStatus().wholeRuntimeQuiet,false)}finally{release?.();await h.cleanup()}
})

test('original module emit swallowing an error cannot erase transfer uncertainty',async()=>{
 const h=await fixture({id:'failure-test',name:'synthetic',setup(api){api.on('synthetic-fail',async()=>{throw Error('synthetic module failure')})}})
 try{h.mods.emit('synthetic-fail');await new Promise(r=>setTimeout(r,0));assert.equal(h.mods.transferStatus().failures,1);await assert.rejects(h.mods.drainCallbacks(),/requires review/)}finally{await h.cleanup()}
})

async function fixture(definition){
 const f=await qqFixture(),calls=[]
 const c=createOneBotCapabilities({...f,selfId:10001,allowTargets:['group:30001'],authorize:()=>assert.fail('must not ask approval'),transport:async(action,params)=>{calls.push({action,params});return action==='get_group_member_info'?{role:'owner'}:{}}})
 let cfg={safeMode:true,ownerQQ:'20001',botQQ:'10001',allow:{groups:['30001']},dryRun:false,modules:{}}
 const logger={child(){return this},info(){},warn(){},error(){},debug(){}}
 const core={onebot:c.moduleClient,hub:{turnHasOwner:()=>true},groupRoles:createGroupRoles({onebot:c.moduleClient,getConfig:()=>cfg,log:logger})}
 const mods=createModules({ctx:f.ctx,core,getConfig:()=>cfg,setConfig:v=>{cfg=v},logger,version:'isolated',builtins:[definition||groupAdmin],wrapTool:(t,opts)=>c.wrapAutonomousTool(t,opts)})
 await mods.boot()
 const tools=()=>mods.buildTools({chat:{kind:'group',groupId:'30001'},level:'full',sessionId:f.agent.id})
 return {f,c,calls,mods,tools,disable:()=>{cfg={...cfg,modules:{[definition?.id||groupAdmin.id]:{enabled:false}}}},cleanup:async()=>{mods.dispose();await f.cleanup()}}
}

test('original module kernel builds original group-admin tool and native runtime executes without approval',async()=>{
 const h=await fixture();try{
  assert.equal(h.mods.running(groupAdmin.id),'builtin')
  const off=h.f.agent.ctx.tools.register(h.tools()[0])
  try{const result=await h.f.call('qq_group_admin',{action:'ban',group_id:'30001',user_id:'20002',minutes:1},'module-native');assert.equal(result.value.ok,true)}finally{off()}
  assert.equal(h.calls.filter(c=>c.action==='set_group_ban').length,1)
  assert.equal(h.c.audit()[0].authorization,'autonomous')
 }finally{await h.cleanup()}
})

test('stopped and reloaded module cannot execute a stale tool reference',async()=>{
 const h=await fixture();try{
  const old=h.tools()[0],args={action:'ban',group_id:'30001',user_id:'20002',minutes:1},exec={agent:h.f.agent,callId:'stale'}
  h.mods.stop(groupAdmin.id)
  await assert.rejects(old.execute(args,exec),/stopped or replaced/)
  await h.mods.reload(groupAdmin.id)
  await assert.rejects(old.execute(args,exec),/stopped or replaced/)
  await h.tools()[0].execute(args,{...exec,callId:'fresh'})
  assert.equal(h.calls.filter(c=>c.action==='set_group_ban').length,1)
 }finally{await h.cleanup()}
})

test('disable removes module tools; repeated dispose and boot do not resurrect them',async()=>{
 const h=await fixture();try{
  h.disable();await h.mods.sync();assert.equal(h.tools().length,0)
  h.mods.dispose();h.mods.dispose();await h.mods.boot();await h.mods.reload(groupAdmin.id)
  assert.equal(h.tools().length,0);assert.equal(h.calls.length,0)
 }finally{await h.cleanup()}
})

test('module stopped while async tool waits cannot reach transport afterward',async()=>{
 let release,entered;const ready=new Promise(r=>{entered=r}),wait=new Promise(r=>{release=r})
 const def={id:'async-test',setup(api){api.tool({name:'async_test',execute:async()=>{entered();await wait;return api.onebot('set_essence_msg',{message_id:10})}})}}
 const h=await fixture(def);try{
  const running=h.tools()[0].execute({},{agent:h.f.agent,callId:'waiting'})
  await ready;h.mods.stop(def.id);release()
  await assert.rejects(running,/stopped or replaced/);assert.equal(h.calls.length,0);assert.equal(h.c.audit().length,0)
 }finally{release();await h.cleanup()}
})

test('dispose during module boot does not recreate watchers, globals or modules',async()=>{
 const h=await fixture();try{
  const boot=h.mods.boot();h.mods.dispose();await boot
  assert.equal(h.mods.running(groupAdmin.id),null)
  assert.equal(globalThis.aurabot,undefined)
  await h.mods.sync();assert.equal(h.tools().length,0)
 }finally{await h.cleanup()}
})

test('kernel fails closed when host omitted its existing capability binding',()=>{
 assert.throws(()=>createModules({}),/host tool binding required/)
})

test('repeated module boot reuses one lifecycle and preserves existing tool references',async()=>{
 const h=await fixture();try{
  const old=h.tools()[0],boot=h.mods.boot();assert.equal(h.mods.boot(),boot);await boot
  await old.execute({action:'ban',group_id:'30001',user_id:'20002',minutes:1},{agent:h.f.agent,callId:'still-live'})
  assert.equal(h.calls.filter(c=>c.action==='set_group_ban').length,1)
 }finally{await h.cleanup()}
})

test('pending module delay is cancelled on stop and cannot restart on repeated boot',async()=>{
 let count=0
 const h=await fixture({id:'timer-test',setup(api){api.later(20,()=>{count++})}})
 try{h.mods.stop('timer-test');await h.mods.boot();await new Promise(r=>setTimeout(r,40));assert.equal(count,0)}finally{await h.cleanup()}
})
