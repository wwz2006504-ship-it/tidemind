import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {runtimeBootstrapFixture as fixture} from './runtime-bootstrap-fixture.mjs'
import * as fenced from './fenced-store.mjs'

test('runtime transfer drains real owned sessions but cannot seal while external module evidence is missing',async()=>{
 const f=await fixture();try{const r=await f.start();const preview=await r.transfer.prepare('transfer-preview',{dryRun:true});assert.equal(preview.dryRun,true);assert.equal(r.sourceAdmission.status().state,'open')
 await f.emit(f.event(19555));await assert.rejects(r.transfer.prepare('actual-runtime-drain'),/final subsystem proof/)
 const proof=r.transfer.inspect();assert.equal(proof.agents.busy,0);assert.equal(proof.agents.pending,0);assert.equal(proof.authority.quiet,true);assert.equal(proof.quiet,false);assert.ok(proof.blockers.includes('module-external-resources-unverified'))
 assert.equal(r.memoryBarrier.status().state,'open');assert.equal(r.sourceAdmission.status().state,'paused');assert.equal(f.lease.status().holder,'local');assert.equal(f.sent.length,1)
 r.sourceAdmission.resume('actual-runtime-drain')
 }finally{await f.cleanup()}
})

test('runtime transfer refuses deferred input without freezing or dropping original event',async()=>{
 const f=await fixture();try{const r=await f.start();r.sourceAdmission.pause('late-runtime');await f.emit(f.event(19556));await assert.rejects(r.transfer.prepare('late-runtime'),/deferred input/);assert.equal(r.sourceAdmission.status().pending,1);assert.equal(r.memoryBarrier.status().state,'open');assert.equal(f.sent.length,0)}finally{await f.cleanup()}
})

test('source pause blocks both exact and module panel routes before side effects and module reload',async()=>{
 const f=await fixture();try{const r=await f.start();r.sourceAdmission.pause('panel-pause')
 const request=async path=>{let result;const route=f.routes.get(path)||f.routes.get('/aurabot/api');await route.handler({url:path},{setHeader(){},end(value){result=JSON.parse(value)}});return result}
 for(const path of ['/aurabot/api/snowluma/start','/aurabot/api/state','/aurabot/api/ext/synthetic/write']){const result=await request(path);assert.equal(result.ok,false);assert.match(result.message,/source paused/)}
 assert.equal(r.host.transferLifecycle.status().panel.active,0);assert.equal(r.host.transferLifecycle.status().panel.failures,0)
 assert.equal((await r.host.modules.sync()).skipped,'source-paused');await assert.rejects(r.host.modules.reload('memory'),/source pause/)
 r.sourceAdmission.resume('panel-pause');assert.equal((await request('/aurabot/api/logs')).ok,true)
 }finally{await f.cleanup()}
})

test('host close waits actual async module cleanup rather than only unregistering it',async()=>{
 const f=await fixture();let release;try{const r=await f.start(),module=r.host.modules.use('memory');module.dispose=()=>new Promise(resolve=>release=resolve)
 let closed=false;const closing=r.close().then(()=>closed=true)
 for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setTimeout(resolve,5))
 assert.equal(typeof release,'function');assert.equal(closed,false);release();await closing;assert.equal(closed,true)
 }finally{release?.();await f.cleanup()}
})

test('real candidate Hub drains admitted owner turn without freezing memory prematurely',async()=>{
 const f=await fixture();try{
  const r=await f.start();await f.emit(f.event(19333));r.sourceAdmission.pause('hub-drain')
  await r.sourceAdmission.drain();const result=await r.host.hub.drainIncoming({timeoutMs:10000})
  assert.equal(result.pending,0);assert.equal(result.active,0);assert.equal(result.busy,false);assert.equal(result.failures,0)
  assert.equal(f.agent.status,'idle');assert.equal(f.requests.length,1)
  assert.equal(r.memoryBarrier.status().state,'open');assert.equal(r.sourceAdmission.status().state,'paused')
  assert.equal((await r.host.hub.drainIncoming()).pending,0)
 }finally{await f.cleanup()}
})
test('actual loader, presets, existing authority and original memory/host start together; rest gates startup and timed maintenance',async()=>{
 const f=await fixture();try{
  const runtime=await f.start();assert.equal(runtime.status().tasks.control.rest,1);assert.equal(f.requests.length,0);assert.equal(f.gateway.head(f.lease).revision,0)
  await fenced.tickTide();assert.equal(runtime.status().tasks.control.spent,0)
  await f.emit(f.event(19001));for(let i=0;i<300&&(f.requests.length<1||f.agent.status!=='idle'||f.sent.length<1);i++)await new Promise(r=>setTimeout(r,5))
  assert.equal(f.sent.length,1,JSON.stringify({errors:f.errors.map(e=>e.message),logs:runtime.host.logger.recent(30)}));assert.match(JSON.stringify(f.requests[0].messages),/SYNTHETIC BOOTSTRAP IDENTITY/)
  await runtime.supervisor.setRest(false,{op:'bootstrap-wake'});await fenced.tickTide();assert.equal(runtime.status().tasks.control.spent,1)
  await runtime.supervisor.setRest(true,{op:'bootstrap-sleep'});await fenced.tickTide();assert.equal(runtime.status().tasks.control.spent,1)
  runtime.supervisor.enqueue({id:'bootstrap-cognitive',input:'SYNTHETIC FOUR PHASE TASK',units:1});await runtime.supervisor.idle();assert.equal(f.requests.length,1)
  await runtime.supervisor.setRest(false,{op:'bootstrap-cognitive-wake'});await runtime.supervisor.idle()
  assert.equal(runtime.status().tasks.tasks.find(t=>t.id==='bootstrap-cognitive').state,'done');assert.equal(f.requests.length,5);assert.equal(f.sent.length,1);assert.ok(f.requests.slice(1).every(r=>r.maxTokens===128&&JSON.stringify(r.messages).includes('SYNTHETIC BOOTSTRAP IDENTITY')))
  assert.deepEqual(readFileSync(join(f.paths.sourceDataRoot,'config.json')),f.config);assert.deepEqual(readFileSync(join(f.paths.sourceDataRoot,'personas/synthetic.md')),f.persona);assert.deepEqual(readFileSync(join(f.paths.sourceDataRoot,'memories.json')),f.jsonMemory)
  await runtime.close();await runtime.close();assert.equal(f.routes.size,0);assert.equal(f.lifecycle.stop,1);assert.equal(runtime.status().closed,true)
 }finally{await f.cleanup()}
})
test('missing or still-enabled legacy entries reject bootstrap before mounting any new host',async()=>{const f=await fixture();try{await f.loader.root.update([{id:'dsh-memory-layers',name:'dsh-memory-layers',disabled:true}]);await assert.rejects(f.start(),/legacy entry missing/);assert.equal(f.routes.size,0)}finally{await f.cleanup()}})
test('source drift rejects startup and releases process ownership for a corrected attempt',async()=>{const f=await fixture();try{writeFileSync(join(f.paths.sourceDataRoot,'config.json'),'CHANGED');await assert.rejects(f.start(),/configuration changed/);assert.equal(f.routes.size,0);writeFileSync(join(f.paths.sourceDataRoot,'config.json'),f.config);const r=await f.start();assert.ok(r.host);await r.close()}finally{await f.cleanup()}})
test('failed required module drains partial memory and driver before corrected startup',async()=>{const f=await fixture();try{f.spec.requiredModules=['missing-original-module'];await assert.rejects(f.start(),/required original module failed/);assert.equal(f.routes.size,0);assert.equal(f.ctx.tools.get('lmem_write'),undefined);delete f.spec.requiredModules;const r=await f.start();await f.emit(f.event(19002));for(let i=0;i<300&&(f.requests.length<1||f.sent.length<1);i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.sent.length,1);await r.close()}finally{await f.cleanup()}})
test('closed runtime can restart on same context without a stale cognitive request listener',async()=>{const f=await fixture();try{const first=await f.start();await first.close();const second=await f.start();second.supervisor.enqueue({id:'restart-cognitive',input:'SYNTHETIC AFTER RESTART',units:1});await second.supervisor.setRest(false,{op:'restart-wake'});await second.supervisor.idle();assert.equal(second.status().tasks.tasks.find(t=>t.id==='restart-cognitive').state,'done');assert.equal(f.requests.length,4);assert.deepEqual(f.errors,[]);await second.close()}finally{await f.cleanup()}})

test('composite snapshot includes actual owned JSON and persona revisions without changing original baselines',async()=>{
 const f=await fixture();try{
  const r=await f.start(),before=r.compositeHead();assert.equal(before.json.revision,0);assert.equal(before.persona.revision,0)
  const memory=r.protectedMemory.load();memory.items.push({id:'new-composite-memory',text:'SYNTHETIC NEW DAY'});r.protectedMemory.save(memory)
  const person=r.identity.readPersona();r.identity.savePersona(person.id,{...person,body:person.body+' SYNTHETIC NEW VERSION'})
  const after=r.compositeHead();assert.equal(after.json.revision,1);assert.equal(after.persona.revision,1);assert.notEqual(after.digest,before.digest);assert.equal(after.json.baseline,before.json.baseline);assert.equal(after.persona.baseline,before.persona.baseline);assert.deepEqual(after.sqlite,before.sqlite)
  assert.deepEqual(readFileSync(join(f.paths.sourceDataRoot,'personas/synthetic.md')),f.persona);assert.deepEqual(readFileSync(join(f.paths.sourceDataRoot,'memories.json')),f.jsonMemory)
 }finally{await f.cleanup()}
})

import {createHash} from 'node:crypto'
test('original AI plugin mounts its real tools and index on protected private library, and composite head includes it',async()=>{
 const f=await fixture();try{
  const directory=join(f.root,'private-ai');mkdirSync(directory);const source=join(f.paths.sourceDataRoot,'ai-original.jsonl'),raw=Buffer.from(JSON.stringify({seq:1,at:1,type:'node.created',data:{id:'original-ai',kind:'insight',text:'SYNTHETIC ORIGINAL AI JUDGMENT'}})+'\n');writeFileSync(source,raw)
  f.spec.aiMemory={source,directory,baselineSha256:createHash('sha256').update(raw).digest('hex'),config:{injectIndex:true,maxIndexEntries:40,maxGraphNodes:500}}
  await f.loader.root.update([{id:'dsh-memory-layers',name:'dsh-memory-layers',disabled:true},{id:'dsh-heartbeat',name:'dsh-plugin-heartbeat',disabled:true},{id:'dsh-ai-memory',name:'dsh-ai-memory',disabled:true}]);await f.loader.await()
  const r=await f.start();assert.ok(f.ctx.tools.get('memory_search'));assert.ok(f.ctx.tools.get('memory_write'));const before=r.compositeHead();assert.equal(before.aiMemory.revision,0)
  r.aiMemory.operations.write({kind:'insight',text:'SYNTHETIC NEW DAY AI'});const after=r.compositeHead();assert.equal(after.aiMemory.revision,1);assert.notEqual(before.aiMemory.hash,after.aiMemory.hash);assert.deepEqual(readFileSync(source),raw)
  r.memoryBarrier.begin('all-store-freeze')
  assert.throws(()=>r.protectedMemory.save(r.protectedMemory.load()),/writes stopped/)
  const p=r.identity.readPersona();assert.throws(()=>r.identity.savePersona(p.id,{...p,body:p.body+' BLOCKED'}),/writes stopped/)
  assert.throws(()=>r.aiMemory.lib.commit([{seq:3,at:3,type:'node.created',data:{id:'blocked-ai',kind:'insight',text:'BLOCKED'}}]),/writes stopped/)
  const sql=new fenced.MemoryStore(f.localDir);try{await assert.rejects(fenced.bindAgent(f.agent,{callId:'blocked-memory-write'},()=>sql.write({layer:'semantic',content:'SYNTHETIC BLOCKED SQLITE',source:'tool'},Date.now())),/writes stopped/)}finally{await sql.close()}
  assert.equal(r.memoryBarrier.seal('all-store-freeze',()=>r.compositeHead()).head.digest,after.digest)
  r.memoryBarrier.resume('all-store-freeze')
  await r.close();assert.equal(f.ctx.tools.get('memory_write'),undefined);assert.equal(f.routes.size,0)
 }finally{await f.cleanup()}
})

test('candidate host pauses before any module or model dispatch and preserves incoming QQ event privately',async()=>{
 const f=await fixture();try{const r=await f.start();r.sourceAdmission.pause('host-incoming-pause');const result=await f.emit(f.event(29001));assert.equal(result.deferred,true);assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);assert.equal(r.sourceAdmission.status().pending,1);assert.throws(()=>r.sourceAdmission.resume('host-incoming-pause'),/needs replay/);await r.close();await assert.rejects(f.start(),/paused source admission/)}finally{await f.cleanup()}
})

test('deferred owner QQ event re-enters the same original candidate host and produces one native reply',async()=>{
 const f=await fixture();try{const r=await f.start();r.sourceAdmission.pause('replay-owner');await f.emit(f.event(29002));assert.equal(f.requests.length,0);assert.equal((await r.host.replayDeferred('replay-owner')).forwarded,1)
  for(let i=0;i<300&&(f.requests.length<1||f.sent.length<1||f.agent.status!=='idle');i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(f.requests.length,1,JSON.stringify(f.errors));assert.equal(f.sent.length,1);assert.equal(r.sourceAdmission.status().pending,0);assert.equal((await r.host.replayDeferred('replay-owner')).forwarded,0);assert.equal(f.sent.length,1);r.sourceAdmission.resume('replay-owner')
 }finally{await f.cleanup()}
})
