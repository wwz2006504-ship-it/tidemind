import {test} from 'node:test'
import assert from 'node:assert/strict'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {createRemoteQQ} from './remote-qq.mjs'
import {createRemoteTasks} from './remote-tasks.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
const event={post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:30001,message:[{type:'text',data:{text:'SYNTHETIC INBOUND'}}]},message={chatId:'private:20001',messageId:'30001',userId:'20001'}
const capture=text=>({sent:[{chatId:message.chatId,message:[{type:'text',data:{text}}]}],result:[{kind:'text',text}]})
const bind=origin=>({sessionId:'synthetic-session',turn:1,chatId:message.chatId,origins:[origin]})
async function setupQQ(transport){const f=await authorityHttpFixture({qqConfig:{selfId:10001,allowTargets:['private:20001'],transport}});const qq=createRemoteQQ({authority:f.local,term:f.term});const inbound=await qq.observeInbound(event,message);const binding={...bind(inbound.origin),replyIdentity:'synthetic-final'};await qq.bindTurn(binding);return {...f,qq,binding}}
test('remote original inbox/outbox deduplicate text reply and reject changed payload or old term',async()=>{
 let sends=0;const f=await setupQQ(async()=>({message_id:++sends}));try{
  assert.equal((await f.qq.observeInbound(event,message)).duplicate,true)
  assert.equal((await f.qq.reply(f.binding,async()=>capture('SYNTHETIC REPLY'))).state,'sent')
  assert.equal((await f.qq.reply(f.binding,async()=>assert.fail('cached reply must not re-render'))).attempted,false);assert.equal(sends,1)
  await assert.rejects(f.qq.reply({...f.binding,replyIdentity:'CHANGED SOURCE'},async()=>capture('CHANGED')),e=>e.status===409)
  await assert.rejects(f.local.request('/qq/reply',{term:f.term,binding:{...f.binding,replyIdentity:hash(f.binding.replyIdentity)},capture:capture('FORGED RENDER')}),e=>e.status===409)
  await f.local.request('/admin',{command:'release',term:f.term});const grant=await f.local.request('/admin',{command:'acquire'})
  await assert.rejects(f.qq.reply(f.binding,async()=>assert.fail('stale term rendered')),e=>e.status===409)
  assert.equal((await createRemoteQQ({authority:f.local,term:grant.term}).reply(f.binding,async()=>capture('SYNTHETIC REPLY'))).attempted,false);assert.equal(sends,1)
 }finally{await f.cleanup()}
})
test('lost remote reply response can be queried and replayed without another OneBot attempt',async()=>{
 let sends=0;const f=await setupQQ(async()=>({message_id:++sends}));try{
  const qq=createRemoteQQ({term:f.term,authority:{request:async(path,body)=>{const result=await f.local.request(path,body);if(path==='/qq/reply')throw Error('SYNTHETIC LOST RESPONSE');return result}}})
  await assert.rejects(qq.reply(f.binding,async()=>capture('SYNTHETIC REPLY')),/LOST RESPONSE/)
  assert.equal((await f.qq.audit()).outbox[0].state,'sent');await f.qq.reply(f.binding,async()=>capture('SYNTHETIC REPLY'));assert.equal(sends,1)
 }finally{await f.cleanup()}
})
test('unknown transport outcome never auto resends; remote media is explicitly rejected',async()=>{
 let sends=0;const f=await setupQQ(async()=>{sends++;throw Error('SYNTHETIC TRANSPORT LOST')});try{
  assert.equal((await f.qq.reply(f.binding,async()=>capture('SYNTHETIC REPLY'))).state,'unknown')
  assert.equal((await f.qq.reply(f.binding,async()=>capture('SYNTHETIC REPLY'))).attempted,false);assert.equal(sends,1)
  await assert.rejects(f.local.request('/qq/reply',{term:f.term,binding:{...f.binding,replyIdentity:hash(f.binding.replyIdentity)},capture:{sent:[{chatId:message.chatId,message:[{type:'image',data:{file:'C:/FORBIDDEN'}}]}],result:[{kind:'image'}]}}),e=>e.status===409)
 }finally{await f.cleanup()}
})
test('unconfigured original authority does not expose QQ or task capabilities',async()=>{const f=await authorityHttpFixture();try{await assert.rejects(f.local.request('/qq/status',{term:f.term}),e=>e.status===423);await assert.rejects(f.local.request('/task/status',{term:f.term}),e=>e.status===423)}finally{await f.cleanup()}})
test('source handover pause defers new remote events before inbox admission',async()=>{const f=await setupQQ(async()=>({message_id:1}));try{
 await f.local.request('/transfer/pause',{term:f.term,op:'pause-remote-input'})
 assert.equal((await f.qq.observeInbound({...event,message_id:30002},{...message,messageId:'30002'})).deferred,true)
 assert.equal((await f.qq.audit()).inbox,1)
}finally{await f.cleanup()}})
test('remote tool uses original exact permit; duplicate, altered request and cloud privilege checks hold',async()=>{
 let actions=0;const f=await setupQQ(async(action)=>{actions++;return {status:'ok',retcode:0,action}});try{
 const invocation={op:'synthetic-tool',sessionId:'synthetic-session',callId:'synthetic-call',action:'set_group_ban',params:{group_id:30001,user_id:20002,duration:1}}
 // The configured private target must not authorize an unrelated group.
 await assert.rejects(f.qq.callTool(invocation),e=>e.status===409);assert.equal(actions,0)
 const safe={...invocation,action:'get_cookies',params:{domain:'SYNTHETIC.invalid'}}
 await f.qq.callTool(safe);assert.equal(actions,1);assert.equal((await f.qq.callTool(safe)).replayed,true);assert.equal(actions,1)
 await assert.rejects(f.qq.callTool({...safe,params:{domain:'CHANGED.invalid'}}),e=>e.status===409)
 await assert.rejects(f.qq.callTool({...safe,op:'send-bypass',action:'send_private_msg',params:{user_id:20001,message:'NO'}}),e=>e.status===409)
 await f.local.request('/admin',{command:'release',term:f.term});const grant=await f.cloud.request('/admin',{command:'acquire'})
 await assert.rejects(createRemoteQQ({authority:f.cloud,term:grant.term}).callTool({...safe,op:'cloud-tool'}),e=>e.status===409);assert.equal(actions,1)
 }finally{await f.cleanup()}
})
test('remote original tool unknown outcome is retained and never re-executed',async()=>{
 let actions=0;const f=await setupQQ(async()=>{actions++;throw Error('SYNTHETIC TOOL LOST')});try{
 const invocation={op:'unknown-tool',sessionId:'synthetic-session',callId:'synthetic-call',action:'get_cookies',params:{domain:'SYNTHETIC.invalid'}}
 await assert.rejects(f.qq.callTool(invocation),e=>e.status===409);await assert.rejects(f.qq.callTool(invocation),e=>e.status===409);assert.equal(actions,1)
 }finally{await f.cleanup()}
})
test('remote original scheduler preserves four phases, budget, idempotency and actual rest',async()=>{
 let calls=0;const handlers=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>{calls++;return 'SYNTHETIC '+p}]))
 const f=await authorityHttpFixture({taskConfig:{handlers,budget:8}}),tasks=createRemoteTasks({authority:f.local,term:f.term});try{
  const task={id:'synthetic-task',input:'SYNTHETIC INPUT',units:1};await tasks.enqueue(task);assert.equal(calls,0)
  await tasks.setRest(false,{op:'resume'});let status
  for(let i=0;i<100;i++){status=await tasks.status();if(status.tasks[0]?.state==='done')break;await new Promise(r=>setTimeout(r,5))}
  assert.equal(status.tasks[0].phase,4);assert.equal(calls,4);assert.equal(status.control.spent,4)
  assert.equal((await tasks.enqueue(task)).replayed,true);await assert.rejects(tasks.enqueue({...task,input:'DIFFERENT'}),e=>e.status===409)
  assert.equal((await tasks.setRest(true,{op:'rest'})).drained,true);await tasks.enqueue({...task,id:'rest-queued'});assert.equal(calls,4)
  assert.ok((await tasks.trace(task.id)).length>0)
  await f.local.request('/admin',{command:'release',term:f.term});await f.local.request('/admin',{command:'acquire'})
  await assert.rejects(tasks.setRest(false,{op:'stale-resume'}),e=>e.status===409)
 }finally{await f.cleanup()}
})
test('remote rest aborts running handler and waits for cleanup; budget exhaustion stops further phases',async()=>{
 let entered=false,cleaned=false,calls=0
 const handler=async({signal})=>{entered=true;calls++;await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true})});cleaned=true;signal.throwIfAborted()}
 const f=await authorityHttpFixture({taskConfig:{handlers:{observe:handler,reflect:handler,plan:handler,verify:handler},budget:4}}),tasks=createRemoteTasks({authority:f.local,term:f.term});try{
 await tasks.enqueue({id:'active-rest',input:'SYNTHETIC',units:1});await tasks.setRest(false,{op:'wake-active'})
 for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,5));assert.equal(entered,true)
 const receipt=await tasks.setRest(true,{op:'stop-active'});assert.equal(receipt.drained,true);assert.equal(cleaned,true);assert.equal(calls,1);assert.equal((await tasks.status()).tasks[0].state,'paused')
 }finally{await f.cleanup()}
 let phases=0;const pure=async()=>{phases++;return 'SYNTHETIC BUDGET'}
 const g=await authorityHttpFixture({taskConfig:{handlers:{observe:pure,reflect:pure,plan:pure,verify:pure},budget:2}}),limited=createRemoteTasks({authority:g.local,term:g.term});try{
 await limited.enqueue({id:'limited',input:'SYNTHETIC',units:1});await limited.setRest(false,{op:'wake-limited'})
 let status;for(let i=0;i<100;i++){status=await limited.status();if(status.tasks[0]?.state==='blocked_budget')break;await new Promise(r=>setTimeout(r,5))}
 assert.equal(status.tasks[0].state,'blocked_budget');assert.equal(phases,2);assert.equal(status.control.spent,2)
 }finally{await g.cleanup()}
})
