import test from 'node:test'
import assert from 'node:assert/strict'
import {aurabotHost} from './aurabot-host-fixture.mjs'
import {apply} from '../host/aurabot/src/host.js'

test('original host entry mounts real module kernel, prompt variables and panel routes in real Cordis',async()=>{
 const f=await aurabotHost();try{
  assert.equal(f.handle.modules.running('group-admin'),'builtin')
  assert.equal(f.lifecycle.seed,1);assert.equal(f.lifecycle.refresh,1)
  const prompt=await f.ctx.systemPrompt.assemble({scope:f.agent,agent:f.agent})
  assert.equal(prompt.variables.aurabot_persona,'SYNTHETIC PERSONA')
  assert.deepEqual(Object.keys(f.handle.onebot),['call'])
  const state=await f.request('/state');assert.equal(state.ok,true);assert.equal(state.config.botQQ,'10001')
  assert.equal(state.personas[0].id,'synthetic');assert.equal(f.calls.length,0)
 }finally{await f.cleanup()}
})

test('original host event callback completes native conversation, memory and one fenced reply; repeated input does not resend',async()=>{
 const f=await aurabotHost();try{
  const protectedHash=f.replica.replicaHead(f.local).protected_hash
  await f.emit(f.event());await f.settle()
  assert.equal(f.sent.length,1);assert.deepEqual(f.errors,[])
  assert.ok(JSON.stringify(f.requests[0].messages).includes('合成检索标记'))
  assert.ok(f.read("SELECT id FROM memories WHERE content LIKE '%蓝色风铃%'").length>0)
  assert.equal(f.replica.replicaHead(f.local).protected_hash,protectedHash)
  const revision=f.gateway.head(f.lease).revision
  await f.emit(f.event());await new Promise(r=>setTimeout(r,20))
  assert.equal(f.sent.length,1);assert.equal(f.gateway.head(f.lease).revision,revision)
  assert.equal(f.calls[0].options.singleAttempt,true)
 }finally{await f.cleanup()}
})

test('host unmount withdraws routes and module tools, and stale inbound callback cannot start work',async()=>{
 const f=await aurabotHost();try{
  const old=f.handle.modules.buildTools({chat:{kind:'group',groupId:'30001'},level:'full',sessionId:f.agent.id}).find(t=>t.name==='qq_group_admin')
  await f.unmount();await f.unmount()
  assert.equal(f.routes.size,0);assert.equal(f.lifecycle.snowDispose,1)
  const prompt=await f.ctx.systemPrompt.assemble({scope:f.agent,agent:f.agent})
  assert.equal(prompt.variables.aurabot_persona,undefined)
  await f.emit(f.event());assert.equal(f.requests.length,0);assert.equal(f.sent.length,0)
  await assert.rejects(f.handle.onebot.call('get_login_info'),/host stopped/)
  await assert.rejects(old.execute({action:'ban',group_id:'30001',user_id:'20002',minutes:1},{agent:f.agent,callId:'stale-entry'}),/stopped or replaced/)
 }finally{await f.cleanup()}
})

test('host entry without explicit isolated bindings refuses to read configuration or mount',()=>{
 assert.throws(()=>apply({}),/isolated host bindings required/)
})

test('native conversation calls original module tool through host assembly, and hot reload refreshes same-name mounted tools',async()=>{
 const f=await aurabotHost({mode:'module-group-admin'});try{
  await f.emit(f.event(2001,'合成群管任务'));await f.settle()
  assert.equal(f.calls.filter(c=>c.action==='set_group_ban').length,1)
  await f.handle.modules.reload('group-admin')
  await f.emit(f.event(2002,'合成第二个群管任务'));await f.settle(2)
  assert.deepEqual(f.errors,[])
  assert.equal(f.calls.filter(c=>c.action==='set_group_ban').length,2)
  assert.equal(f.requests.length,4)
  const results=f.agent.session.snapshotEvents().filter(e=>e.type==='tool/result')
  assert.equal(results.length,2);assert.ok(results.every(e=>!e.data.message.isError))
 }finally{await f.cleanup()}
})

test('host exit cancels delayed startup rather than reconnecting after unload',async()=>{
 const f=await aurabotHost();try{
  await f.unmount();await new Promise(r=>setTimeout(r,3100))
  assert.equal(f.lifecycle.start,0);assert.equal(f.lifecycle.stop,1);assert.equal(f.lifecycle.refresh,1)
 }finally{await f.cleanup()}
})

test('watchdog awaiting a service cannot launch QQ or a process after host exit',async()=>{
 let release,entered;const ready=new Promise(r=>{entered=r}),waiting=new Promise(r=>{release=r})
 const f=await aurabotHost({snowRunning:async()=>{entered();return waiting}})
 try{
  await ready;let closed=false;const closing=f.unmount().then(()=>{closed=true});await new Promise(r=>setTimeout(r,20));assert.equal(closed,false);release(false);await closing
  assert.equal(f.lifecycle.start,0);assert.equal(f.lifecycle.stop,1)
  assert.ok(!f.handle.logger.recent(500).some(e=>e.text.includes('unexpected process launch')))
 }finally{release(false);await f.cleanup()}
})

test('host unmount removes QQ tools already mounted on a live original agent',async()=>{
 const f=await aurabotHost({mode:'module-group-admin'});try{
  await f.emit(f.event(2101,'合成群管任务'));await f.settle()
  await f.unmount()
  const assembly=await f.ctx.systemPrompt.assemble({scope:f.agent,agent:f.agent})
  assert.ok(!JSON.stringify(assembly.tools).includes('qq_group_admin'))
  const result=await f.agent.ctx.tools.execute({name:'qq_group_admin',arguments:{action:'ban',group_id:'30001',user_id:'20002',minutes:1},callId:'after-unmount',agent:f.agent,signal:new AbortController().signal})
  assert.ok(result.isError||result.value?.ok===false||result.error)
  assert.equal(f.calls.filter(c=>c.action==='set_group_ban').length,1)
 }finally{await f.cleanup()}
})
