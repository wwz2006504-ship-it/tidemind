import test from 'node:test'
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {qqFixture} from './qq-fixture.mjs'
import {controllerHost} from './controller-host.mjs'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
import {createCognitiveDriver} from './cognitive-driver.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import groupAdmin from '../host/aurabot/src/modules/group-admin/index.js'
import {createGroupRoles} from '../host/aurabot/src/chat/group-roles.js'
const phases=['observe','reflect','plan','verify']
async function capabilities(transport){
 const f=await qqFixture(),calls=[]
 const c=createOneBotCapabilities({...f,selfId:10001,allowTargets:['private:20001','group:30001'],authorize:()=>assert.fail('no human approval callback'),transport:transport|| (async(action,params)=>{calls.push({action,params});return action==='get_group_member_info'?{role:'owner'}:{}})})
 return {f,c,calls}
}
test('default autonomous module tool writes directly, never asks approval and replay does not repeat transport',async()=>{
 const {f,c,calls}=await capabilities();try{
  const tool=c.wrapAutonomousTool({execute:()=>c.moduleClient.call('set_group_ban',{group_id:30001,user_id:20002,duration:60})}),exec={agent:f.agent,callId:'autonomy-call'}
  await tool.execute({},exec);await tool.execute({},exec)
  assert.equal(c.authorizationMode,'autonomous');assert.equal(calls.length,1);assert.equal(c.audit()[0].authorization,'autonomous')
 }finally{await f.cleanup()}
})
test('default autonomy executes existing unlisted tool APIs and multiple operations without per-action approval',async()=>{
 const {f,c,calls}=await capabilities();try{
  const tool=c.wrapAutonomousTool({execute:async()=>{await c.moduleClient.call('set_essence_msg',{message_id:10});await c.moduleClient.call('set_essence_msg',{message_id:11})}})
  await tool.execute({},{agent:f.agent,callId:'batch-call'});assert.equal(calls.length,2);assert.equal(c.audit().length,2)
 }finally{await f.cleanup()}
})
test('actual original group-admin tool runs autonomously through real ToolRuntime with no added consent',async()=>{
 const {f,c,calls}=await capabilities();try{
  const config={ownerQQ:'20001',botQQ:'10001',allow:{groups:['30001']},dryRun:false},roles=createGroupRoles({onebot:c.moduleClient,getConfig:()=>config,log:{debug(){}}});let factory
  groupAdmin.setup({core:{hub:{turnHasOwner:()=>true},onebot:c.moduleClient,groupRoles:roles},config:()=>config,tool:fn=>{factory=fn},context(){},route(){}})
  const definition=factory({chat:{kind:'group',groupId:'30001'},level:'full',sessionId:f.agent.id}),off=f.agent.ctx.tools.register(c.wrapAutonomousTool(definition))
  const result=await f.call('qq_group_admin',{action:'ban',group_id:'30001',user_id:'20002',minutes:1},'native-auto');off();assert.equal(result.value.ok,true);assert.equal(calls.filter(r=>r.action==='set_group_ban').length,1)
 }finally{await f.cleanup()}
})
test('autonomous tool ACK loss remains uncertain; autonomy does not turn retry into a second side effect',async()=>{
 let count=0;const {f,c}=await capabilities(async()=>{count++;throw Error('synthetic ACK loss')})
 try{const tool=c.wrapAutonomousTool({execute:()=>c.moduleClient.call('set_essence_msg',{message_id:10})}),exec={agent:f.agent,callId:'unknown'}
  await assert.rejects(tool.execute({},exec),/unconfirmed/);await assert.rejects(tool.execute({},exec),/requires review/);assert.equal(count,1)
 }finally{await f.cleanup()}
})
test('default cognitive driver retains existing tools and completes native work without approval',async()=>{
 const f=await controllerHost({mode:'work-tool'});let s;let count=0
 try{
  const off=f.ctx.tools.register({name:'work_marker',description:'synthetic work',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[{type:'text',text:'done'}]},execute:async()=>{count++;return {ok:true}}})
  const driver=await createCognitiveDriver({ctx:f.ctx,controller:f.controller,sessionId:'tidemind-cognitive-autonomous',cwd:join(f.root,'cognitive')})
  s=createTaskCheckpoints({...f,handlers:Object.fromEntries(phases.map(p=>[p,driver.handle])),budget:8});s.enqueue({id:'native-work',input:'合成自主工作',units:2});await s.setRest(false,{op:'wake'});await s.idle()
  assert.equal(s.status().tasks[0].state,'done');assert.equal(count,1);assert.equal(f.requests.length,5);assert.deepEqual(f.errors,[]);off()
 }finally{if(s)await s.close();await f.cleanup()}
})
test('default active task may use bound memory tools while original core/persona protection remains',async()=>{
 const f=await controllerHost();let s
 try{
  let result;const before=f.replica.replicaHead(f.local).protected_hash
  const handlers=Object.fromEntries(phases.map(p=>[p,async()=>p]));handlers.observe=async()=>{result=await f.ctx.tools.execute({name:'lmem_write',arguments:{layer:'semantic',content:'合成自主工作记忆'},callId:'auto-memory',agent:f.agent,signal:new AbortController().signal});return 'saved'}
  s=createTaskCheckpoints({...f,handlers,budget:8});s.enqueue({id:'memory-work',input:'synthetic',units:1});await s.setRest(false,{op:'wake'});await s.idle()
  assert.equal(result.value.ok,true);assert.equal(f.read("SELECT count(*) n FROM memories WHERE content='合成自主工作记忆'")[0].n,1);assert.equal(f.replica.replicaHead(f.local).protected_hash,before)
 }finally{if(s)await s.close();await f.cleanup()}
})
