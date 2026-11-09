import {test} from 'node:test'
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {mkdirSync} from 'node:fs'
import {aurabotHost} from './aurabot-host-fixture.mjs'
import {authorityHttpFixture,keys} from './authority-http-fixture.mjs'
import {createRemoteSourceAdmission} from './remote-source-admission.mjs'
import {prepareRemoteHostCapabilities} from './remote-host-capabilities.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
import {createRemoteActivitySupervisor} from './remote-activity-supervisor.mjs'

async function mountRemote(options={}){
 let server,source,tasks;const sent=[]
 const h=await aurabotHost({...options,prepareBindings:async({f,paths})=>{
  server=await authorityHttpFixture({storageFixture:f,...(options.remoteActivities?{taskConfig:{budget:20,handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=> 'SYNTHETIC '+p]))}}:{}),qqConfig:{selfId:10001,allowTargets:['private:20001','group:30001'],mediaProtocol:'immutable-upload-v1',transport:async(action,params)=>{if(action.startsWith('send_'))sent.push({action,params});return action==='get_group_member_info'?{role:'owner'}:{message_id:96000+sent.length}}}})
  const raw={request:(path,body)=>options.intercept?options.intercept(path,body,server.local):server.local.request(path,body)}
  tasks=options.remoteActivities?createRemoteActivitySupervisor({authority:raw,term:f.term}):null
  const authority=tasks?.authority||raw
  source=createRemoteSourceAdmission({authority,term:f.term})
  const mediaRoot=join(paths.TIDEMIND_AURABOT_DATA_ROOT,'media');mkdirSync(mediaRoot)
  return {sourceAdmission:source,...(tasks?{taskSupervisor:tasks,remoteTaskControl:tasks}:{}),createCapabilities:await prepareRemoteHostCapabilities({authority,term:f.term,selfId:10001,historyReader:createSessionHistoryReader(f.ctx.sessionPersistence),historyKey:keys.local,mediaRoot,sourceAdmission:source})}
 }})
 return {h,server,source,tasks,sent,async close(){try{try{await h.unmount()}finally{await tasks?.close()}}finally{try{await server.cleanup()}finally{await h.cleanup()}}}}
}

test('same original host completes actual SDK conversation through remote authority without local sender',async()=>{
 let h,server,source;const sent=[]
 try{
  h=await aurabotHost({prepareBindings:async({f,paths})=>{
   server=await authorityHttpFixture({storageFixture:f,qqConfig:{selfId:10001,allowTargets:['private:20001','group:30001'],mediaProtocol:'immutable-upload-v1',transport:async(action,params)=>{if(action.startsWith('send_'))sent.push({action,params});return {message_id:95000+sent.length}}}})
   source=createRemoteSourceAdmission({authority:server.local,term:f.term})
   const mediaRoot=join(paths.TIDEMIND_AURABOT_DATA_ROOT,'media');mkdirSync(mediaRoot)
   const createCapabilities=await prepareRemoteHostCapabilities({authority:server.local,term:f.term,selfId:10001,historyReader:createSessionHistoryReader(f.ctx.sessionPersistence),historyKey:keys.local,mediaRoot,sourceAdmission:source})
   return {createCapabilities,sourceAdmission:source}
  }})
  await h.emit(h.event(76001))
  for(let i=0;i<400;i++){if(h.agent.status==='idle'&&sent.length===1)break;await new Promise(r=>setTimeout(r,5))}
  await h.handle.transferLifecycle.drainSessionEvents()
  assert.equal(sent.length,1,'remote canonical transport must deliver once')
  assert.equal(h.sent.length,0,'raw local sender must never be used')
  assert.equal(sent[0].action,'send_private_msg')
  assert.ok(h.agent.session.snapshotEvents().some(e=>e.type==='turn/end'),'real original SDK completed turn')
  await h.emit(h.event(76001));assert.equal(sent.length,1)
  await source.pause('remote-host-pause')
  assert.equal((await h.emit(h.event(76002))).deferred,true)
  assert.equal(sent.length,1)
  assert.equal((await source.drain()).durableActive,0)
  assert.deepEqual(h.errors,[])
 }finally{if(h)await h.cleanup();if(server)await server.cleanup()}
})

test('actual host input failure is durable review, not a completed source callback',async()=>{
 const f=await mountRemote({intercept:(path,body,client)=>{if(path==='/qq/observe')throw Error('SYNTHETIC OBSERVATION LOST');return client.request(path,body)}})
 try{
  await assert.rejects(f.h.emit(f.h.event(76003)),/OBSERVATION LOST/)
  await f.source.pause('failed-host-input')
  assert.equal((await f.source.status()).uncertain,1)
  assert.equal(f.sent.length,0);assert.equal(f.h.sent.length,0);assert.equal(f.h.requests.length,0)
  await assert.rejects(f.source.resume('failed-host-input'),e=>e.status===409)
  await assert.rejects(f.source.drain(),/unresolved/)
 }finally{await f.close()}
})

test('actual host native module tool runs once via canonical remote permit and never raw local transport',async()=>{
 const f=await mountRemote({mode:'module-group-admin'})
 try{
  await f.h.emit(f.h.event(76004))
  for(let i=0;i<400;i++){if(f.h.agent.status==='idle'&&f.sent.length)break;await new Promise(r=>setTimeout(r,5))}
  await f.h.handle.transferLifecycle.drainSessionEvents()
  const db=f.h.lease.openAuthority();try{const rows=db.prepare('SELECT action,state,call_id FROM tide_tool_permits').all();assert.equal(rows.length,1);assert.equal(rows[0].action,'set_group_ban');assert.equal(rows[0].state,'succeeded');assert.equal(rows[0].call_id,'synthetic-module-1')}finally{db.close()}
  assert.equal(f.sent.length,1);assert.equal(f.h.calls.length,0);assert.deepEqual(f.h.errors,[])
  await f.h.emit(f.h.event(76004));assert.equal(f.sent.length,1)
 }finally{await f.close()}
})

const timerModule={id:'synthetic-remote-wake',setup(api){api.every(60000,()=>api.core.hub.pushToSession({chatId:'private:20001',kind:'private',userId:'20001'},[{type:'text',text:'SYNTHETIC REMOTE AUTONOMY'}],''));return {}}}
test('same host managed autonomous module uses remote original budget and actual native turn; rest prevents wake',async()=>{
 const f=await mountRemote({remoteActivities:true,builtins:[timerModule]})
 try{
  const callback=f.h.activityCallbacks.find(r=>r.moduleId===timerModule.id)
  assert.equal((await callback.run()).skipped,'rest');assert.equal(f.h.requests.length,0)
  await f.tasks.setRest(false,{op:'remote-native-wake'})
  assert.equal((await callback.run()).state,'done')
  assert.equal(f.h.requests.length,1);assert.equal(f.sent.length,1);assert.equal(f.h.calls.length,0)
  const status=await f.tasks.status();assert.equal(status.control.spent,1);assert.equal(status.tasks.filter(t=>t.state==='done').length,1)
  assert.equal((await f.tasks.setRest(true,{op:'remote-native-rest'})).drained,true)
  assert.equal((await callback.run()).skipped,'rest');assert.equal(f.h.requests.length,1);assert.deepEqual(f.h.errors,[])
 }finally{await f.close()}
})

test('same host remote rest cancels actual pending native model and confirms cleanup before stopping',async()=>{
 const f=await mountRemote({remoteActivities:true,mode:'wait-abort',builtins:[timerModule]})
 try{
  await f.tasks.setRest(false,{op:'remote-wait-wake'});const pending=f.h.activityCallbacks.find(r=>r.moduleId===timerModule.id).run()
  for(let i=0;i<200&&f.h.requests.length===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.h.requests.length,1)
  assert.equal((await f.tasks.setRest(true,{op:'remote-wait-sleep'})).drained,true)
  assert.equal((await pending).state,'needs_review');assert.equal(f.h.agent.status,'idle');assert.equal(f.sent.length,0);assert.equal(f.h.sent.length,0)
 }finally{await f.close()}
})

