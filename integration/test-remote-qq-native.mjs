import {test} from 'node:test'
import assert from 'node:assert/strict'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {createRemoteQQ} from './remote-qq.mjs'
import {createRemoteQQToolScope} from './remote-qq-tool-scope.mjs'
import {controllerHost} from './controller-host.mjs'
import groupAdmin from '../host/aurabot/src/modules/group-admin/index.js'
test('actual Controller runs original group-admin through remote exact permit with actual SDK call identity',async()=>{
 const packets=[];const f=await authorityHttpFixture({qqConfig:{selfId:10001,allowTargets:['group:30001'],transport:async(action,params)=>{packets.push({action,params});return {status:'ok',retcode:0}}}});let host,dispose
 try{
  host=await controllerHost({storageFixture:{...f,cleanup:()=>{}},mountMemory:false,mode:'module-group-admin'})
  const qq=createRemoteQQ({authority:f.local,term:f.term}),scope=createRemoteQQToolScope({qq,assertHostActive:()=>{}}),builders=[]
  groupAdmin.setup({config:()=>({ownerQQ:'20001',allow:{groups:['30001']}}),context:()=>{},route:()=>{},tool:builder=>builders.push(builder),core:{onebot:scope.moduleClient,hub:{turnHasOwner:()=>true},groupRoles:{get:async()=> 'owner',canManage:()=>true}}})
  const definition=builders[0]({chat:{kind:'private'},level:'full',sessionId:host.agent.id});dispose=host.ctx.tools.register(scope.wrapTool(definition))
  host.agent.followup({id:'synthetic-native-remote-qq',role:'user',content:[{type:'text',text:'SYNTHETIC ONLY'}],source:{kind:'plugin'}})
  let ended=false;for(let i=0;i<1000;i++){ended=host.agent.status==='idle'&&host.agent.session.snapshotEvents().some(e=>e.type==='turn/end');if(ended)break;await new Promise(r=>setTimeout(r,5))}
  assert.equal(ended,true);assert.deepEqual(host.errors,[]);assert.deepEqual(packets,[{action:'set_group_ban',params:{group_id:30001,user_id:20002,duration:60}}])
  const db=f.lease.openAuthority();try{const row=db.prepare('SELECT session_id,call_id,state FROM tide_tool_permits').get();assert.equal(row.session_id,host.agent.id);assert.equal(row.call_id,'synthetic-module-1');assert.equal(row.state,'succeeded')}finally{db.close()}
 }finally{dispose?.();if(host)await host.cleanup();await f.cleanup()}
})
test('remote tool scope refuses unbound and escaped operations without touching remote authority',async()=>{
 let attempts=0
 const scope=createRemoteQQToolScope({qq:{callTool:async()=>{attempts++;return {}},read:async()=>({})},assertHostActive:()=>{}})
 await assert.rejects(scope.moduleClient.call('set_group_ban',{}),/actual original tool invocation required/)
 await assert.rejects(scope.moduleClient.call('send_private_msg',{}),/bound outbox/)
 const tool=scope.wrapTool({execute:()=>({ok:true})})
 await assert.rejects(tool.execute({},{}),/actual SDK/)
 // Preserve a callback's inherited scope exactly as a delayed module continuation would.
 let pending,release;const deferred=new Promise(r=>release=r)
 const delayed=scope.wrapTool({execute:()=>{pending=deferred.then(()=>scope.moduleClient.call('set_group_ban',{}));return {ok:true}}})
 await delayed.execute({},{agent:{id:'synthetic',session:{id:'synthetic'}},callId:'synthetic-call'});release();await assert.rejects(pending,/invocation ended/);assert.equal(attempts,0)
})
