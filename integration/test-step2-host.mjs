import test from 'node:test'
import assert from 'node:assert/strict'
import {host} from './isolated-host.mjs'

test('real DSH tools write is fully applied, then retrieved in CURRENT-turn context',async()=>{
 const h=await host();try{
  const out=await h.call('lmem_write',{layer:'episodic',content:'合成麦克风使用Pillow工具',tags:'合成'},'write-one')
  assert.equal(out.isError,false);assert.equal(out.value.ok,true)
  assert.equal(h.read("SELECT count(*) n FROM memories WHERE layer='episodic'")[0].n,1)
  await h.claim('合成麦克风使用什么工具',1)
  const ctx=await h.context();assert.match(ctx.text,/Pillow/)
  assert.ok(ctx.assembled.sections.some(s=>s.text==='SYNTHETIC DEPLOYMENT PERSONA'))
 }finally{await h.cleanup()}
})
test('actual turn-stopping auto capture is journaled; replayed turn stays once',async()=>{
 const h=await host();try{
  await h.claim('请记住：合成星球有三颗月亮',1);await h.stop()
  const n=h.read("SELECT count(*) n FROM memories WHERE layer!='core'")[0].n
  assert.ok(n>0);const revision=h.gateway.head(h.lease).revision
  await h.stop();assert.equal(h.gateway.head(h.lease).revision,revision)
 }finally{await h.cleanup()}
})
test('scheduled tide callback flows through authority and preserves identity',async()=>{
 const h=await host();try{
  const before=h.replica.replicaHead(h.local).protected_hash
  const prior=h.gateway.head(h.lease).revision
  await h.tick();assert.equal(h.gateway.head(h.lease).revision,prior)
  assert.equal(h.replica.replicaHead(h.local).protected_hash,before)
 }finally{await h.cleanup()}
})
test('wrong session mapping cannot retrieve or write; original core remains',async()=>{
 const h=await host();try{
  const other={id:'other-agent',session:{id:'other-session'},ctx:h.ctx,turn:1}
  const out=await h.call('lmem_write',{layer:'episodic',content:'不应写入的合成记录'},'unauthorized',other)
  assert.equal(out.isError,true)
  assert.equal(h.read("SELECT count(*) n FROM memories WHERE layer='episodic'")[0].n,0)
  assert.equal((await h.context(other)).text,'')
 }finally{await h.cleanup()}
})

test('lmem_update and lmem_review really apply, with no source-persona rewrite',async()=>{
 const h=await host();try{
  const protectedBefore=h.replica.replicaHead(h.local).protected_hash
  const created=await h.call('lmem_write',{layer:'semantic',content:'合成待审资料',status:'pending'},'new-pending')
  const id=created.value.id
  const approved=await h.call('lmem_review',{action:'approve',id},'approve');assert.equal(approved.isError,false)
  const withdrawn=await h.call('lmem_update',{id,status:'withdrawn'},'withdraw');assert.equal(withdrawn.isError,false)
  assert.equal(h.read('SELECT status FROM memories WHERE id=?',id)[0].status,'withdrawn')
  assert.equal(h.replica.replicaHead(h.local).protected_hash,protectedBefore)
 }finally{await h.cleanup()}
})
test('core/persona, hard deletion and restore capabilities fail closed',async()=>{
 const h=await host();try{
  const before=h.replica.replicaHead(h.local)
  for(const [name,args]of [['lmem_write',{layer:'core',content:'禁止的人格改变'}],['lmem_update',{id:h.core.id,content:'禁止覆盖'}],['lmem_forget',{id:h.core.id}],['lmem_admin',{action:'restore',path:'not-used'}]]){
   const out=await h.call(name,args,'blocked-'+name);assert.equal(out.isError,true,name)
  }
  assert.deepEqual(h.replica.replicaHead(h.local),before)
 }finally{await h.cleanup()}
})
test('stale term blocks tool, capture and tide writes while retrieval stays usable',async()=>{
 const h=await host(raw=>raw.write({layer:'episodic',content:'合成可读麦克风记忆'}));try{
  h.lease.release('local',h.term);h.lease.acquire('local')
  const before=h.replica.replicaHead(h.local),revision=h.gateway.head(h.lease).revision
  const out=await h.call('lmem_write',{layer:'episodic',content:'旧任期禁止写入'},'oldterm');assert.equal(out.isError,true)
  await h.claim('请记住：合成彗星有七条尾巴',1);await h.stop();await h.tick()
  assert.deepEqual(h.replica.replicaHead(h.local),before);assert.equal(h.gateway.head(h.lease).revision,revision)
  await h.claim('合成麦克风记忆',2);assert.match((await h.context()).text,/麦克风/)
 }finally{await h.cleanup()}
})
test('unavailable authority causes no bypass; input context still builds',async()=>{
 const h=await host();try{
  const before=h.replica.replicaHead(h.local),fenced=h.lease.fenced
  h.lease.fenced=()=>{throw new Error('simulated authority unavailable')}
  const out=await h.call('lmem_write',{layer:'episodic',content:'不应旁路写入'},'offline');assert.equal(out.isError,true)
  await h.claim('请记住：合成恒星是绿色的',1);await h.stop();await h.tick()
  assert.deepEqual(h.replica.replicaHead(h.local),before)
  await h.claim('普通合成问题',2);assert.equal(typeof(await h.context()).text,'string')
  h.lease.fenced=fenced
 }finally{await h.cleanup()}
})
test('parallel real ToolRuntime calls serialize; same call replay is idempotent',async()=>{
 const h=await host();try{
  const results=await Promise.all([
   h.call('lmem_write',{layer:'episodic',content:'合成并发事件甲'},'parallel-a'),
   h.call('lmem_write',{layer:'episodic',content:'合成并发事件乙'},'parallel-b')])
  assert.ok(results.every(r=>!r.isError));assert.equal(h.read("SELECT count(*) n FROM memories WHERE layer='episodic'")[0].n,2)
  const repeated=await h.call('lmem_write',{layer:'episodic',content:'合成并发事件甲'},'parallel-a')
  assert.equal(repeated.value.id,results[0].value.id);assert.equal(h.read("SELECT count(*) n FROM memories WHERE layer='episodic'")[0].n,2)
 }finally{await h.cleanup()}
})
test('startup tide retires old inputs; scheduled repeat is idempotent',async()=>{
 const old=Date.now()-100*86400000
 const h=await host(raw=>raw.write({layer:'episodic',content:'合成启动退潮事件'},old));try{
  assert.equal(h.read("SELECT count(*) n FROM memories WHERE layer='episodic' AND valid_to IS NOT NULL")[0].n,1)
  const entries=h.gateway.committedSince(h.lease)
  assert.ok(entries.some(e=>e.mutation.storeResult.total>=1))
  const before=h.replica.replicaHead(h.local);await h.tick()
  assert.deepEqual(h.replica.replicaHead(h.local),before)
 }finally{await h.cleanup()}
})
