import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {createRemoteActivitySupervisor} from './remote-activity-supervisor.mjs'
import {controllerHost} from './controller-host.mjs'
import {createCognitiveDriver} from './cognitive-driver.mjs'
async function setup({mode='reply',intercept}={}){
 const f=await authorityHttpFixture({taskConfig:{execution:'remote-client',budget:8}})
 let host,driver,tasks
 try{
  host=await controllerHost({storageFixture:{...f,cleanup:()=>{}},mountMemory:false,reasoning:true,mode})
  const cwd=join(f.root,'cognitive-workspace');mkdirSync(cwd)
  driver=await createCognitiveDriver({ctx:host.ctx,controller:host.controller,sessionId:'tidemind-cognitive-remote-test',cwd})
  const authority={request:(path,body)=>intercept?intercept(path,body,f.local):f.local.request(path,body)}
  tasks=createRemoteActivitySupervisor({authority,term:f.term})
  return {...f,host,driver,tasks,async cleanup(){try{await tasks.close()}catch{}try{driver.dispose();await host.closeRuntime()}finally{await f.cleanup()}}}
 }catch(error){if(host)await host.closeRuntime();await f.cleanup();throw error}
}
const task={id:'synthetic-remote-cognitive',input:'SYNTHETIC FOUR PHASES',units:1}
test('original scheduler executes four phases in actual remote client driver with durable per-request audit',async()=>{
 const f=await setup();try{
  await f.tasks.enqueue(task);assert.equal((await f.tasks.runNextPhase(f.driver)).rest,true);assert.equal(f.host.requests.length,0)
  await f.tasks.setRest(false,{op:'wake-phases'})
  for(let i=0;i<4;i++){const result=await f.tasks.runNextPhase(f.driver);assert.equal(result.state,'done')}
  const status=await f.tasks.status();assert.equal(status.tasks[0].state,'done');assert.equal(status.tasks[0].phase,4);assert.equal(status.control.spent,4);assert.equal(f.host.requests.length,4)
  const trace=await f.tasks.trace(task.id);assert.equal(trace.filter(e=>e.event==='model-request').length,4)
  assert.equal((await f.tasks.runNextPhase(f.driver)).waiting,true);assert.deepEqual(f.host.errors,[])
 }finally{await f.cleanup()}
})
test('remote phase rest cancels actual driver and preserves original paused checkpoint',async()=>{
 const f=await setup({mode:'wait-abort'});try{
  await f.tasks.enqueue(task);await f.tasks.setRest(false,{op:'wake-phases'})
  const pending=f.tasks.runNextPhase(f.driver)
  for(let i=0;i<200&&f.host.requests.length===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.host.requests.length,1)
  assert.equal((await f.tasks.setRest(true,{op:'sleep-phases'})).drained,true)
  assert.equal((await pending).state,'needs_review');assert.equal(f.driver.agent.status,'idle')
  const row=(await f.tasks.status()).tasks[0];assert.equal(row.state,'paused');assert.equal(row.phase,0)
 }finally{await f.cleanup()}
})
test('lost phase claim reply cannot cause a second driver invocation',async()=>{
 let lose=true;const f=await setup({intercept:async(path,body,client)=>{const value=await client.request(path,body);if(path==='/task/phase/next'&&lose&&value.active){lose=false;throw Error('SYNTHETIC PHASE CLAIM LOST')}return value}})
 try{
  await f.tasks.enqueue(task);await f.tasks.setRest(false,{op:'wake-phases'})
  assert.equal((await f.tasks.runNextPhase(f.driver)).state,'needs_review');assert.equal(f.host.requests.length,0)
  assert.equal((await f.tasks.runNextPhase(f.driver)).waiting,true);assert.equal(f.host.requests.length,0)
  const status=await f.tasks.status();assert.equal(status.tasks[0].state,'running');assert.equal(status.clientFailures,1)
 }finally{await f.cleanup()}
})
test('unconfirmed model request audit prevents the actual provider request',async()=>{
 const f=await setup({intercept:(path,body,client)=>{if(path==='/task/phase/model-request')throw Error('SYNTHETIC AUDIT UNAVAILABLE');return client.request(path,body)}})
 try{
  await f.tasks.enqueue(task);await f.tasks.setRest(false,{op:'wake-phases'})
  assert.equal((await f.tasks.runNextPhase(f.driver)).state,'needs_review');assert.equal(f.host.requests.length,0)
  assert.equal((await f.tasks.status()).tasks[0].state,'failed')
 }finally{await f.cleanup()}
})
