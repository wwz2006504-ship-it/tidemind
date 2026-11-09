import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {remoteRuntimeFixture} from './remote-runtime-fixture.mjs'
import * as fenced from './fenced-store.mjs'
test('unique existing startup mounts original host, four stores and phase worker without a local authority binding',async()=>{
 const f=await remoteRuntimeFixture();try{
  const beforePersona=readFileSync(join(f.paths.sourceDataRoot,'personas/synthetic.md')),beforeJson=readFileSync(join(f.paths.sourceDataRoot,'memories.json')),beforeAi=readFileSync(f.spec.aiMemory.source)
  const r=await f.start();assert.equal(f.spec.authority.lease,undefined);assert.equal(r.host.getConfig().persona.current,'synthetic')
  await f.emit(f.event(79001))
  for(let i=0;i<400;i++){if(f.agent.status==='idle'&&f.remoteSent.length)break;await new Promise(resolve=>setTimeout(resolve,5))}
  await r.host.transferLifecycle.drainSessionEvents();await fenced.drain()
  assert.equal(f.remoteSent.length,1);assert.equal(f.sent.length,0)
  const proof=await r.compositeHead();assert.equal(proof.digest,(await f.network.local.request('/state/head',{})).digest)
  await f.emit(f.event(79001));assert.equal(f.remoteSent.length,1)
  await r.supervisor.enqueue({id:'remote-bootstrap-phases',input:'SYNTHETIC CONTINUOUS GOAL',units:1})
  const before=f.requests.length;await new Promise(resolve=>setTimeout(resolve,50));assert.equal(f.requests.length,before)
  await r.supervisor.setRest(false,{op:'bootstrap-wake'})
  let state;for(let i=0;i<300;i++){state=await r.supervisor.status();if(state.tasks.some(t=>t.id==='remote-bootstrap-phases'&&t.state==='done'))break;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal(state.tasks.find(t=>t.id==='remote-bootstrap-phases').state,'done');assert.equal(f.requests.length,before+4)
  assert.equal((await r.supervisor.setRest(true,{op:'bootstrap-rest'})).drained,true)
  assert.deepEqual(readFileSync(join(f.paths.sourceDataRoot,'personas/synthetic.md')),beforePersona);assert.deepEqual(readFileSync(join(f.paths.sourceDataRoot,'memories.json')),beforeJson);assert.deepEqual(readFileSync(f.spec.aiMemory.source),beforeAi)
  assert.equal((await r.transfer.inspect()).wholeRuntimeQuiet,false);assert.deepEqual(f.errors,[])
  const prepared=await r.transfer.drain('bootstrap-drain')
  assert.equal(prepared.drained,true);assert.equal(prepared.sealed,false)
  assert.equal((await r.memoryBarrier.status()).state,'open')
  await f.emit(f.event(79002));assert.equal(f.remoteSent.length,1)
  await assert.rejects(r.transfer.drain('bootstrap-drain'),/deferred input/)
  await r.close();assert.equal(f.routes.size,0)
 }finally{await f.cleanup()}
})
test('unique remote startup refuses missing original AI or history binding and cleans partial ownership',async()=>{
 const f=await remoteRuntimeFixture();try{
  const key=f.spec.remoteHistoryKey;delete f.spec.remoteHistoryKey
  await assert.rejects(f.start(),/private key/)
  assert.equal(f.routes.size,0);f.spec.remoteHistoryKey=key
  const r=await f.start();assert.equal((await r.status()).closed,false)
 }finally{await f.cleanup()}
})
