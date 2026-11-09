import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {executeStoreOperation,prepareStoreOperation} from './store-adapter.mjs'
import {storeHash} from './store-batch.mjs'
import {DatabaseSync} from 'node:sqlite'
async function run(f,op,operation,gw=f.gateway){const h=f.gateway.head(f.lease);return executeStoreOperation({gateway:gw,lease:f.lease,holder:'local',term:f.term,srcDbPath:f.local,operation,op,expectedRevision:h.revision,expectedHash:h.hash})}
const write=(content,key)=>({method:'write',args:[{layer:'episodic',content,key,source:'tool'}]})
test('original-generated ID, timestamps and FTS actually reach both replicas',async()=>{
 const f=await fixture();try{
  const result=await run(f,'new',write('合成麦克风录音计划'))
  assert.ok(result.committed);const row=f.read('SELECT * FROM memories WHERE id=?',result.result.id)[0]
  assert.ok(row.created_at>1);assert.equal(row.content,'合成麦克风录音计划')
  assert.equal(f.read(`SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH '"麦克风"'`)[0].n,1)
  const h=f.gateway.head(f.lease),expected=f.replica.replicaHead(f.cloud)
  f.replica.materialize(f.cloud,f.gateway.committedSince(f.lease),{expected,sourceHead:h,home:'cloud'})
  assert.equal(f.replica.replicaHead(f.local).data_hash,f.replica.replicaHead(f.cloud).data_hash)
 }finally{f.cleanup()}
})
test('same-key replacement is one batch including predecessor and superseded_by',async()=>{
 const f=await fixture();try{
  const old=await run(f,'old',write('合成旧计划','current-task'))
  const newer=await run(f,'newer',write('合成新计划','current-task'))
  const row=f.read('SELECT * FROM memories WHERE id=?',old.result.id)[0]
  assert.equal(row.status,'superseded');assert.ok(row.valid_to);assert.equal(row.superseded_by,newer.result.id)
  assert.equal(f.read("SELECT count(*) n FROM memories WHERE key='current-task' AND status='active'")[0].n,1)
 }finally{f.cleanup()}
})
test('duplicate refresh preserves original-store semantics without extra memory row',async()=>{
 const f=await fixture();try{
  await run(f,'one',write('合成重复记忆'))
  const refreshed=await run(f,'two',{method:'write',args:[{layer:'episodic',content:'合成重复记忆',tags:['新增标签']}]})
  assert.equal(refreshed.result.action,'duplicate');assert.equal(f.read("SELECT count(*) n FROM memories WHERE layer='episodic'")[0].n,1)
  assert.match(f.read('SELECT tags FROM memories WHERE id=?',refreshed.result.id)[0].tags,/新增标签/)
 }finally{f.cleanup()}
})
test('withdrawal and pending review are applied with valid_to, never hard-delete',async()=>{
 const f=await fixture();try{
  const item=await run(f,'pending',{method:'write',args:[{layer:'semantic',content:'合成待审事实',status:'pending'}]})
  await run(f,'approve',{method:'update',args:[item.result.id,{status:'active'}]})
  await run(f,'withdraw',{method:'update',args:[item.result.id,{status:'withdrawn'}]})
  const row=f.read('SELECT * FROM memories WHERE id=?',item.result.id)[0];assert.equal(row.status,'withdrawn');assert.ok(row.valid_to)
 }finally{f.cleanup()}
})
test('original expireTide goes through journal; core and persona fingerprints remain',async()=>{
 const old=Date.now()-100*86400000
 const f=await fixture(raw=>{raw.write({layer:'episodic',content:'合成旧事件'},old);raw.write({layer:'working',content:'合成旧任务'},old)})
 try{
  const before=f.replica.replicaHead(f.local).protected_hash
  await run(f,'tide',{method:'expireTide',args:[{maturingDays:7,retireDays:30,workingDays:7}]})
  assert.equal(f.read("SELECT count(*) n FROM memories WHERE layer IN ('episodic','working') AND valid_to IS NOT NULL")[0].n,2)
  assert.equal(f.replica.replicaHead(f.local).protected_hash,before)
 }finally{f.cleanup()}
})
test('core, hard delete and unsigned direct commits are rejected before log',async()=>{
 const f=await fixture();try{
  await assert.rejects(run(f,'core',{method:'write',args:[{layer:'core',content:'禁止覆盖'}]}),/protected/)
  await assert.rejects(run(f,'delete',{method:'forget',args:[{id:f.core.id}]}),/unsupported/)
  assert.throws(()=>f.gateway.commit(f.lease,'local',f.term,{op:'raw',mutation:{id:'raw',fields:{status:'withdrawn'}}}),/proof/)
  assert.equal(f.gateway.head(f.lease).revision,0)
 }finally{f.cleanup()}
})
test('expired term leaves actual tables unchanged, not merely the log',async()=>{
 const f=await fixture();try{
  const before=f.replica.replicaHead(f.local);f.lease.release('local',f.term);f.lease.acquire('local')
  await assert.rejects(run(f,'oldterm',write('不应落库的合成记录')),/FENCED/)
  assert.deepEqual(f.replica.replicaHead(f.local),before)
 }finally{f.cleanup()}
})
test('retry after commit-before-apply failure recovers same generated ID once',async()=>{
 const f=await fixture();try{
  const operation=write('合成恢复记忆')
  const crashing={...f.gateway,commit(...args){f.gateway.commit(...args);throw new Error('simulated crash after commit')}}
  await assert.rejects(run(f,'retry',operation,crashing),/simulated/)
  assert.equal(f.replica.replicaHead(f.local).revision,0);assert.equal(f.gateway.head(f.lease).revision,1)
  const retry=await run(f,'retry',operation)
  assert.ok(retry.replayed);assert.equal(f.read("SELECT count(*) n FROM memories WHERE layer='episodic'")[0].n,1)
  await assert.rejects(run(f,'retry',write('不同的合成内容')),/conflict/)
 }finally{f.cleanup()}
})
test('online backup sees uncheckpointed WAL without copying WAL files separately',async()=>{
 const f=await fixture();let writer
 try{
  writer=new f.MemoryStore(f.localDir);writer.write({layer:'episodic',content:'合成尚未checkpoint事件'})
  const plan=await prepareStoreOperation(f.local,write('合成尚未checkpoint事件'))
  assert.equal(plan.storeResult.action,'duplicate')
 }finally{writer?.close();f.cleanup()}
})
