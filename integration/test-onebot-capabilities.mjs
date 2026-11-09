import test from 'node:test'
import assert from 'node:assert/strict'
import {qqFixture} from './qq-fixture.mjs'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
import {createGroupRoles} from '../host/aurabot/src/chat/group-roles.js'
import groupAdmin from '../host/aurabot/src/modules/group-admin/index.js'
const approved=r=>({decision:'allow-once',approvalId:'approval-'+r.op,requestHash:r.requestHash})
async function setup({authorize=approved,transport}={}){
 const f=await qqFixture(),calls=[]
 const c=createOneBotCapabilities({...f,authorizationMode:'per-call',selfId:10001,allowTargets:['private:20001','group:30001'],authorize,transport:transport|| (async(action,params,options)=>{calls.push({action,params,options});if(action==='get_group_member_info')return {role:'owner'};if(action==='get_friend_msg_history')return {messages:[]};return {message_id:70001}})})
 const request=(op='op1',params={group_id:30001,user_id:20002,duration:60})=>({op,sessionId:f.agent.id,callId:'call-'+op,action:'set_group_ban',params})
 const invoke=(ticket,r,action=r.action,params=r.params,exec={agent:f.agent,callId:r.callId})=>c.wrapTool(ticket,{execute:()=>c.moduleClient.call(action,params)}).execute({},exec)
 return {f,c,calls,request,invoke}
}
test('module facade exposes call only; scoped reads work and unknown/foreign parameters never reach transport',async()=>{
 const {f,c,calls}=await setup();try{
  assert.deepEqual(Object.keys(c.moduleClient),['call']);assert.equal(c.moduleClient.start,undefined)
  assert.equal((await c.moduleClient.call('get_group_member_info',{group_id:30001,user_id:10001})).role,'owner')
  for(const [action,params]of [['get_group_info',{group_id:99999}],['get_friend_msg_history',{user_id:99999,count:10}],['get_group_info',{group_id:30001,token:'forged'}],['get_friend_msg_history',{user_id:20001,count:999}]])await assert.rejects(c.moduleClient.call(action,params))
  await assert.rejects(c.moduleClient.call('get_unreviewed',{}));assert.equal(calls.length,1)
 }finally{await f.cleanup()}
})
test('no approval provider, forged approval result and JSON-copied permit cannot authorize a tool',async()=>{
 for(const authorize of [null,()=>({decision:'allow-once',approvalId:'x',requestHash:'wrong'})]){const {f,c,request}=await setup({authorize});try{await assert.rejects(c.grantTool(request()))}finally{await f.cleanup()}}
 const {f,c,request}=await setup();try{const grant=await c.grantTool(request());assert.throws(()=>c.wrapTool(JSON.parse(JSON.stringify(grant.ticket)),{execute(){}}),/host-owned/)}finally{await f.cleanup()}
})
test('one human-approved exact tool operation executes once; concurrent/repeated use stops',async()=>{
 const {f,c,calls,request,invoke}=await setup();try{
  const r=request(),grant=await c.grantTool(r)
  const outcomes=await Promise.allSettled([invoke(grant.ticket,r),invoke(grant.ticket,r)])
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.equal(calls.length,1)
  await assert.rejects(invoke(grant.ticket,r),/used|fenced/);const repeated=await c.grantTool(r);assert.equal(repeated.ticket,null);assert.equal(repeated.state,'succeeded')
 }finally{await f.cleanup()}
})
test('approval is bound to actual ToolRuntime agent/call, action, params and current term',async()=>{
 const {f,c,calls,request,invoke}=await setup();try{
  const r=request(),{ticket}=await c.grantTool(r)
  await assert.rejects(invoke(ticket,r,r.action,r.params,{agent:f.agent,callId:'different'}),/call-bound/)
  await assert.rejects(invoke(ticket,r,r.action,{...r.params,duration:120}),/exact QQ/)
  assert.throws(()=>invoke(ticket,r,r.action,r.params,{agent:{id:'other',session:{id:'other'}},callId:r.callId}),/mismatch/)
  f.lease.release('local',f.term);f.lease.acquire('local');await assert.rejects(invoke(ticket,r),/FENCED/);assert.equal(calls.length,0)
 }finally{await f.cleanup()}
})
test('permit expiry and reuse of one approval ID for another operation both stop',async()=>{
 const {f,c,request,invoke}=await setup({authorize:r=>({...approved(r),approvalId:'same-human-click'})});try{
  const r=request(),grant=await c.grantTool({...r,ttlMs:30000});const db=f.lease.openAuthority();try{db.prepare('UPDATE tide_tool_permits SET expires_at=0 WHERE op=?').run(r.op)}finally{db.close()};await assert.rejects(invoke(grant.ticket,r),/expired/)
  await assert.rejects(c.grantTool(request('op2')))
 }finally{await f.cleanup()}
})
test('lost tool ACK remains unknown across reinitialization; no retry or new approval for same op',async()=>{
 let attempts=0
 const {f,c,request,invoke}=await setup({transport:async()=>{attempts++;throw Error('synthetic secret upstream error')}})
 try{
  const r=request(),{ticket}=await c.grantTool(r);await assert.rejects(invoke(ticket,r),/unconfirmed/);await assert.rejects(invoke(ticket,r),/used|fenced/);assert.equal(attempts,1)
  const restarted=createOneBotCapabilities({...f,authorizationMode:'per-call',selfId:10001,allowTargets:['group:30001'],authorize:()=>assert.fail('second approval'),transport:async()=>assert.fail('repeated send')})
  assert.equal((await restarted.grantTool(r)).state,'unknown');assert.equal(restarted.audit()[0].state,'unknown')
 }finally{await f.cleanup()}
})
test('tool permission never authorizes direct chat sends; normal replies still use existing outbox once',async()=>{
 const {f,c,calls,request,invoke}=await setup();try{
  for(const action of ['send_private_msg','send_group_msg','send_msg','send_poke','set_input_status'])await assert.rejects(c.moduleClient.call(action,{}),/not reviewed/)
  await assert.rejects(c.grantTool({...request(),action:'send_private_msg',params:{user_id:20001,message:'x'}}),/cannot authorize chat/)
  const binding=f.bind([f.event('3001')]);await c.outbound.reply(binding,f.render(binding.chatId,'合成正常回复'));await c.outbound.reply(binding,f.render(binding.chatId,'合成正常回复'))
  assert.equal(calls.length,1);assert.equal(calls[0].action,'send_private_msg');assert.equal(calls[0].options.singleAttempt,true)
 }finally{await f.cleanup()}
})
test('opt-in per-call mode: actual original group-admin tool needs extra per-call consent even when original owner/role checks pass',async()=>{
 const {f,c,request}=await setup();try{
  const factories=[],config={ownerQQ:'20001',botQQ:'10001',allow:{groups:['30001']},dryRun:false},roles=createGroupRoles({onebot:c.moduleClient,getConfig:()=>config,log:{debug(){}}})
  groupAdmin.setup({core:{hub:{turnHasOwner:()=>true,groupName:async()=>''},onebot:c.moduleClient,groupRoles:roles},config:()=>config,tool:fn=>factories.push(fn),context(){},route(){}})
  const definition=factories[0]({chat:{kind:'group',groupId:'30001'},level:'full',sessionId:f.agent.id})
  const off=f.agent.ctx.tools.register(definition)
  const denied=await f.call('qq_group_admin',{action:'ban',group_id:'30001',user_id:'20002',minutes:1},'call-op1');assert.equal(denied.value.ok,false);off()
  const {ticket}=await c.grantTool(request()),stop=f.agent.ctx.tools.register(c.wrapTool(ticket,definition))
  const allowed=await f.call('qq_group_admin',{action:'ban',group_id:'30001',user_id:'20002',minutes:1},'call-op1');assert.equal(allowed.value.ok,true);stop()
 }finally{await f.cleanup()}
})
import {createOneBotClient} from '../host/aurabot/src/onebot/client.js'
test('actual copied OneBot client never falls from HTTP to WS for side effects after ACK loss',async()=>{
 const originalFetch=globalThis.fetch,originalWebSocket=globalThis.WebSocket;let http=0,ws=0,client
 class Socket{
  constructor(){this.readyState=1;queueMicrotask(()=>this.onopen?.())}
  send(encoded){ws++;const message=JSON.parse(encoded);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({echo:message.echo,status:'ok',retcode:0,data:{message_id:1}})}))}
  close(){this.readyState=3;this.onclose?.({code:1000})}
 }
 try{
  globalThis.fetch=async()=>{http++;throw new TypeError('synthetic lost HTTP ACK')};globalThis.WebSocket=Socket
  client=createOneBotClient({endpoint:()=>({httpUrl:'http://synthetic.invalid',wsUrl:'ws://synthetic.invalid'}),onEvent:()=>{},log:{info(){},warn(){}}});client.start();await Promise.resolve()
  await assert.rejects(client.call('send_private_msg',{user_id:20001,message:'synthetic'},{timeoutMs:100}),/ACK/)
  await assert.rejects(client.call('set_group_ban',{group_id:30001,user_id:20002,duration:60},{timeoutMs:100}),/ACK/)
  assert.equal(http,2);assert.equal(ws,0)
  await client.call('get_group_info',{group_id:30001},{timeoutMs:100});assert.equal(ws,1)
 }finally{client?.stop();globalThis.fetch=originalFetch;globalThis.WebSocket=originalWebSocket}
})
import {runCognitiveScope} from './activity-gate.mjs'
test('proactive cognitive scope cannot mint or consume even an otherwise valid tool permission',async()=>{
 const {f,c,request,invoke}=await setup();try{
  const r=request(),{ticket}=await c.grantTool(r)
  await runCognitiveScope(()=>{},async()=>{await assert.rejects(c.grantTool(request('proactive')),/no write/);await assert.rejects(invoke(ticket,r),/no write/)})
  assert.equal(c.audit()[0].state,'approved')
 }finally{await f.cleanup()}
})
test('params mutation after approval cannot change the approved concrete action',async()=>{
 const {f,c,calls,request,invoke}=await setup();try{
  const r=request(),{ticket}=await c.grantTool(r);r.params.duration=120
  await assert.rejects(invoke(ticket,r),/exact QQ/);assert.equal(calls.length,0)
  assert.equal(c.audit()[0].state,'unused');const fresh=request('op2'),grant=await c.grantTool(fresh);await invoke(grant.ticket,fresh);assert.equal(calls.length,1)
 }finally{await f.cleanup()}
})
import qqTools from '../host/aurabot/src/modules/qq-tools/index.js'
test('actual qq-tools history tool uses scoped read facade in real ToolRuntime',async()=>{
 const {f,c,calls}=await setup();try{
  let factory;qqTools.setup({core:{hub:f.hub,onebot:c.moduleClient},tool:fn=>{factory=fn},config:()=>f.cfg})
  const tools=factory({chat:{kind:'private',chatId:'private:20001',userId:'20001'},level:'social'})
  const off=f.agent.ctx.tools.register(tools[0]);const result=await f.call('qq_chat_history',{count:5},'history-call');off()
  assert.equal(result.value.ok,true);assert.equal(calls.length,1);assert.equal(calls[0].action,'get_friend_msg_history');assert.equal(calls[0].params.user_id,20001)
 }finally{await f.cleanup()}
})
test('actual qq-tools cannot bypass bound reply path with qq_send_message',async()=>{
 const {f,c,calls}=await setup();try{
  let factory;qqTools.setup({core:{hub:f.hub,onebot:c.moduleClient},tool:fn=>{factory=fn},config:()=>f.cfg})
  const definitions=factory({chat:{kind:'private',chatId:'private:20001',userId:'20001'},level:'full'})
  const send=definitions.find(t=>t.name==='qq_send_message'),off=f.agent.ctx.tools.register(send)
  const result=await f.call('qq_send_message',{target:'private:20001',text:'合成旁路发送'},'bypass-call');off();assert.equal(result.value.ok,false);assert.equal(calls.length,0);assert.equal(f.sent.length,0)
 }finally{await f.cleanup()}
})
test('actual OneBot side-effect transport rejects contradictory or incomplete success ACKs',async()=>{
 const originalFetch=globalThis.fetch;const client=createOneBotClient({endpoint:()=>({httpUrl:'http://synthetic.invalid'}),onEvent(){},log:{info(){},warn(){}}})
 try{
  for(const packet of [{status:'ok',retcode:1,data:null},{status:'failed',retcode:0,data:null},{status:'ok',data:null}]){
   globalThis.fetch=async()=>({json:async()=>packet});await assert.rejects(client.call('set_group_ban',{group_id:30001,user_id:20002,duration:60}))
  }
 }finally{client.stop();globalThis.fetch=originalFetch}
})

test('an unawaited module continuation loses its permit when the actual tool invocation ends',async()=>{
 const {f,c,calls,request}=await setup();try{
  const r=request(),{ticket}=await c.grantTool(r);let release,finish
  const gate=new Promise(resolve=>{release=resolve}),done=new Promise(resolve=>{finish=resolve})
  const tool=c.wrapTool(ticket,{execute:()=>{
   void(async()=>{await gate;try{await c.moduleClient.call(r.action,r.params);finish('unexpected success')}catch{finish('denied')}})()
   return {ok:true}
  }})
  await tool.execute({},{agent:f.agent,callId:r.callId});release();assert.equal(await done,'denied');assert.equal(calls.length,0);assert.equal(c.audit()[0].state,'unused')
 }finally{await f.cleanup()}
})
