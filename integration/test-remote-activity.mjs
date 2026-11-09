import {test} from 'node:test'
import assert from 'node:assert/strict'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {createRemoteActivitySupervisor} from './remote-activity-supervisor.mjs'
const handlers=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=> 'SYNTHETIC '+p]))
async function setup(intercept){const f=await authorityHttpFixture({taskConfig:{handlers,budget:4},qqConfig:{selfId:10001,allowTargets:['private:20001'],transport:async()=>({user_id:10001})}}),authority={request:(path,body)=>intercept?intercept(path,body,f.local):f.local.request(path,body)},tasks=createRemoteActivitySupervisor({authority,term:f.term});return {...f,tasks,async cleanup(){try{await tasks.close()}catch{}await f.cleanup()}}}
const task=id=>({id:'module:synthetic:'+id,input:'SYNTHETIC CALLBACK',units:1})
test('remote actual callback uses original task budget, durable state and one execution; rest is inert',async()=>{
 const f=await setup();try{let calls=0
  assert.equal((await f.tasks.runActivity(task('rest'),()=>calls++)).skipped,'rest');assert.equal(calls,0)
  await f.tasks.setRest(false,{op:'wake'})
  const result=await f.tasks.runActivity(task('one'),async({guard})=>{guard();assert.equal((await f.tasks.authority.request('/qq/read',{action:'get_login_info',params:{}})).user_id,10001);calls++;return 'SYNTHETIC RESULT'})
  assert.equal(result.state,'done');assert.equal(result.value,'SYNTHETIC RESULT');assert.equal(calls,1)
  const repeated=await f.tasks.runActivity(task('one'),()=>assert.fail('no replay callback'));assert.equal(repeated.replayed,true);assert.equal(repeated.state,'done')
  const status=await f.tasks.status();assert.equal(status.control.spent,1);assert.equal(status.tasks[0].state,'done');assert.equal(status.active,0)
 }finally{await f.cleanup()}
})
test('remote rest aborts actual client callback and waits cleanup before drained confirmation',async()=>{
 const f=await setup();let entered=false,cleaned=false;try{
  await f.tasks.setRest(false,{op:'wake'})
  const running=f.tasks.runActivity(task('stop'),async({signal})=>{entered=true;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await new Promise(r=>setTimeout(r,30));cleaned=true;signal.throwIfAborted()})
  for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,5));assert.equal(entered,true)
  const result=await f.tasks.setRest(true,{op:'sleep'});assert.equal(result.drained,true);assert.equal(cleaned,true);assert.equal((await running).state,'needs_review')
  assert.equal((await f.tasks.status()).tasks[0].state,'needs_review')
 }finally{await f.cleanup()}
})
test('callback requesting its own rest returns without deadlocking or claiming cleanup is complete',async()=>{
 const f=await setup();try{await f.tasks.setRest(false,{op:'wake'})
  let receipt;const result=await f.tasks.runActivity(task('self-rest'),async()=>{receipt=await f.tasks.setRest(true,{op:'self-sleep'});return 'STOPPING'})
  assert.equal(receipt.rest,true);assert.equal(receipt.drained,false);assert.equal(result.state,'needs_review');assert.equal((await f.tasks.status()).active,0)
 }finally{await f.cleanup()}
})
test('server-side rest blocks effects carried by old activity even before client notices pause',async()=>{
 const f=await setup();try{await f.tasks.setRest(false,{op:'wake'})
  let stopped=false
  await f.tasks.runActivity(task('server-stop'),async()=>{
   await f.local.request('/task/rest-request',{term:f.term,rest:true,op:'external-stop'})
   await assert.rejects(f.tasks.authority.request('/qq/read',{action:'get_login_info',params:{}}),e=>e.status===409);stopped=true
  });assert.equal(stopped,true)
 }finally{await f.cleanup()}
})
test('lost begin reply never runs callback and leaves original running claim unresolved',async()=>{
 let lose=true;const f=await setup(async(path,body,client)=>{const value=await client.request(path,body);if(path==='/task/activity/begin'&&lose){lose=false;throw Error('SYNTHETIC LOST BEGIN')}return value})
 try{await f.tasks.setRest(false,{op:'wake'})
  assert.equal((await f.tasks.runActivity(task('lost'),()=>assert.fail('must not execute'))).state,'needs_review')
  const status=await f.tasks.status();assert.equal(status.tasks[0].state,'running');assert.equal(status.clientFailures,1);assert.equal(status.active,1)
 }finally{await f.cleanup()}
})
test('lost finish reply queries canonical done state without re-executing callback',async()=>{
 let lose=true;const f=await setup(async(path,body,client)=>{const value=await client.request(path,body);if(path==='/task/activity/finish'&&lose){lose=false;throw Error('SYNTHETIC LOST FINISH')}return value})
 try{await f.tasks.setRest(false,{op:'wake'});let calls=0
  assert.equal((await f.tasks.runActivity(task('finish'),()=>++calls)).state,'done');assert.equal(calls,1);assert.equal((await f.tasks.status()).clientFailures,0)
 }finally{await f.cleanup()}
})
test('dry-run rest does not cancel client callback; escaped callbacks lose effect permission',async()=>{
 const f=await setup();try{await f.tasks.setRest(false,{op:'wake'})
  let escaped,release
  const later=new Promise(r=>release=r)
  assert.equal((await f.tasks.runActivity(task('dry-run'),async({signal})=>{await f.tasks.setRest(true,{op:'preview',dryRun:true});assert.equal(signal.aborted,false);escaped=later.then(()=>f.tasks.authority.request('/qq/read',{action:'get_login_info',params:{}}))})).state,'done')
  release();await assert.rejects(escaped,/ended|fresh/);assert.equal((await f.tasks.status()).control.rest,0)
 }finally{await f.cleanup()}
})
