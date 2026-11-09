import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {fixture} from './fixture.mjs'
import {createReplicaGenerations} from './replica-generation.mjs'
import {createCompositeHead} from './composite-head.mjs'
const sha=b=>createHash('sha256').update(b).digest('hex'),baseline='a'.repeat(64)
async function setup(){const f=await fixture(),source=join(f.root,'source-sidecars'),directory=join(f.root,'generations');mkdirSync(source);mkdirSync(directory)
 const sourceFiles={'memory.db':f.local,...Object.fromEntries(['new-memories.json','persona-versions.json','ledger.jsonl'].map(n=>[n,join(source,n)]))}
 function mutate(revision=0){for(const name of Object.keys(sourceFiles).slice(1))writeFileSync(sourceFiles[name],JSON.stringify({revision,text:'SYNTHETIC DAY '+revision,baseline}))}
 mutate()
 const verifyGeneration=dir=>{const json=JSON.parse(readFileSync(join(dir,'new-memories.json'))),persona=JSON.parse(readFileSync(join(dir,'persona-versions.json'))),ai=JSON.parse(readFileSync(join(dir,'ledger.jsonl')));return createCompositeHead({sqlite:f.replica.replicaHead(join(dir,'memory.db')),jsonMemory:{overlayRevision:json.revision,overlayHash:sha(readFileSync(join(dir,'new-memories.json'))),baselineSha256:json.baseline},persona:{overlayVersion:persona.revision,currentHash:sha(readFileSync(join(dir,'persona-versions.json'))),sha256:persona.baseline},aiMemory:{revision:ai.revision,hash:sha(readFileSync(join(dir,'ledger.jsonl'))),baseline:ai.baseline}})}
 const sourceHead=()=>{const files=Object.fromEntries(Object.entries(sourceFiles).map(([k,p])=>[k,readFileSync(p)]));const json=JSON.parse(files['new-memories.json']),persona=JSON.parse(files['persona-versions.json']),ai=JSON.parse(files['ledger.jsonl']);return createCompositeHead({sqlite:f.replica.replicaHead(f.local),jsonMemory:{overlayRevision:json.revision,overlayHash:sha(files['new-memories.json']),baselineSha256:baseline},persona:{overlayVersion:persona.revision,currentHash:sha(files['persona-versions.json']),sha256:baseline},aiMemory:{revision:ai.revision,hash:sha(files['ledger.jsonl']),baseline}})}
 return {...f,directory,sourceFiles,mutate,sourceHead,store:createReplicaGenerations({directory,verifyGeneration}),reopen:()=>createReplicaGenerations({directory,verifyGeneration})}
}
test('four-store generation prepares consistently, replay verifies bytes, dry-run leaves directory empty',async()=>{const f=await setup();try{const head=f.sourceHead();await f.store.prepare({sourceFiles:f.sourceFiles,head,dryRun:true});assert.deepEqual(readdirSync(f.directory),[]);const p=await f.store.prepare({sourceFiles:f.sourceFiles,head});assert.equal(p.id,head.digest);assert.equal(f.store.current(),null);assert.equal((await f.store.prepare({sourceFiles:f.sourceFiles,head})).replayed,true)}finally{f.cleanup()}})
test('source drift and corrupt staged contents cannot publish or select a generation',async()=>{const f=await setup();try{const head=f.sourceHead();f.mutate(1);await assert.rejects(f.store.prepare({sourceFiles:f.sourceFiles,head}),/source changed/);assert.equal(f.store.current(),null);const p=await f.store.prepare({sourceFiles:f.sourceFiles,head:f.sourceHead()});writeFileSync(join(p.directory,'ledger.jsonl'),'corrupt');await assert.rejects(f.store.select({id:p.id}),/content changed/);assert.equal(f.store.current(),null)}finally{f.cleanup()}})
test('interruption after journal or pointer recovers previous complete selection and retains all data',async()=>{for(const step of ['journal','pointer']){const f=await setup();try{const old=await f.store.prepare({sourceFiles:f.sourceFiles,head:f.sourceHead()});await f.store.select({id:old.id});f.mutate(1);const next=await f.store.prepare({sourceFiles:f.sourceFiles,head:f.sourceHead()});await assert.rejects(f.store.select({id:next.id,expectedCurrent:{id:old.id},afterStep:s=>{if(s===step)throw Error('SYNTHETIC INTERRUPT')}}),/INTERRUPT/);assert.throws(()=>f.store.current(),/recovery required/);const fresh=f.reopen();await fresh.recover();assert.deepEqual(fresh.current(),{id:old.id});assert.equal((await fresh.inspect(next.id)).id,next.id);assert.equal((await fresh.recover()).replayed,true)}finally{f.cleanup()}}})
test('newer or branched target and stale selection cannot be overwritten',async()=>{const f=await setup();try{const old=await f.store.prepare({sourceFiles:f.sourceFiles,head:f.sourceHead()});f.mutate(1);const next=await f.store.prepare({sourceFiles:f.sourceFiles,head:f.sourceHead()});await f.store.select({id:next.id});await assert.rejects(f.store.select({id:old.id,expectedCurrent:{id:next.id}}),/must not be overwritten/);f.mutate(2);const third=await f.store.prepare({sourceFiles:f.sourceFiles,head:f.sourceHead()});await assert.rejects(f.store.select({id:third.id,expectedCurrent:{id:old.id}}),/selection changed/);assert.deepEqual(f.store.current(),{id:next.id})}finally{f.cleanup()}})
test('candidate rollback preserves generations, is replayable, and refuses newer writes in selected files',async()=>{const f=await setup();try{const old=await f.store.prepare({sourceFiles:f.sourceFiles,head:f.sourceHead()});await f.store.select({id:old.id});f.mutate(1);const next=await f.store.prepare({sourceFiles:f.sourceFiles,head:f.sourceHead()});await f.store.select({id:next.id,expectedCurrent:{id:old.id}});await f.store.rollback({expectedCurrent:{id:next.id}});assert.deepEqual(f.store.current(),{id:old.id});assert.equal((await f.store.rollback({expectedCurrent:{id:next.id}})).replayed,true);await f.store.select({id:next.id,expectedCurrent:{id:old.id}});writeFileSync(join(next.directory,'new-memories.json'),'SYNTHETIC LATER WRITE');await assert.rejects(f.store.rollback({expectedCurrent:{id:next.id}}),/content changed/);assert.deepEqual(f.store.current(),{id:next.id})}finally{f.cleanup()}})

import {runtimeBootstrapFixture} from './runtime-bootstrap-fixture.mjs'
import {createGenerationVerifier} from './generation-verifier.mjs'
import {createSyncDelta,stageSyncDelta} from './sync-delta.mjs'
import {MemoryStore as FencedMemoryStore,bindAgent} from './fenced-store.mjs'
import {authorityHttpFixture,keys as httpKeys} from './authority-http-fixture.mjs'
import {createMaterializerWorker} from './materializer-worker.mjs'
test('four real protected adapters validate a staged generation against runtime composite head',async()=>{
 const f=await runtimeBootstrapFixture();try{
  const aiSource=join(f.paths.sourceDataRoot,'ai-original.jsonl'),aiDir=join(f.root,'own-ai'),directory=join(f.root,'real-generations');mkdirSync(aiDir);mkdirSync(directory)
  const raw=Buffer.from(JSON.stringify({seq:1,at:1,type:'node.created',data:{id:'original-ai',kind:'insight',text:'SYNTHETIC ORIGINAL AI'}})+'\n');writeFileSync(aiSource,raw)
  f.spec.aiMemory={source:aiSource,directory:aiDir,baselineSha256:sha(raw),config:{injectIndex:true}}
  await f.loader.root.update([{id:'dsh-memory-layers',name:'dsh-memory-layers',disabled:true},{id:'dsh-heartbeat',name:'dsh-plugin-heartbeat',disabled:true},{id:'dsh-ai-memory',name:'dsh-ai-memory',disabled:true}]);await f.loader.await()
  const runtime=await f.start(),memory=runtime.protectedMemory.load();memory.items.push({id:'new-generation-json',text:'SYNTHETIC NEW DAY'});runtime.protectedMemory.save(memory)
  const person=runtime.identity.readPersona();runtime.identity.savePersona(person.id,{...person,body:person.body+' SYNTHETIC GENERATION'})
  runtime.aiMemory.operations.write({kind:'insight',text:'SYNTHETIC NEW AI DAY'})
  const verifyGeneration=createGenerationVerifier({ownedRoot:f.root,sourceDataRoot:f.paths.sourceDataRoot,selectedPersona:f.spec.selectedPersona,pins:f.spec.pins,aiSource,aiBaselineSha256:sha(raw)}),store=createReplicaGenerations({directory,verifyGeneration})
  const result=await store.prepare({head:runtime.compositeHead(),sourceFiles:{'memory.db':f.local,'new-memories.json':join(f.paths.dataRoot,'new-memories.json'),'persona-versions.json':join(f.paths.dataRoot,'persona-versions.json'),'ledger.jsonl':join(aiDir,'ledger.jsonl')}})
  assert.equal(result.head.digest,runtime.compositeHead().digest);assert.equal(result.head.json.revision,1);assert.equal(result.head.persona.revision,1);assert.equal(result.head.aiMemory.revision,1);assert.equal(store.current(),null);assert.deepEqual(readFileSync(aiSource),raw)
  const nextMemory=runtime.protectedMemory.load();nextMemory.items.push({id:'delta-json',text:'SYNTHETIC NEXT DAY'});runtime.protectedMemory.save(nextMemory)
  const nextPersona=runtime.identity.readPersona();runtime.identity.savePersona(nextPersona.id,{...nextPersona,body:nextPersona.body+' SYNTHETIC NEXT DAY'})
  runtime.aiMemory.operations.write({kind:'insight',text:'SYNTHETIC NEXT AI DAY'})
  const sql=new FencedMemoryStore(f.localDir);try{await bindAgent(f.agent,{callId:'sync-sql-write'},()=>sql.write({layer:'semantic',content:'SYNTHETIC NEXT SQLITE DAY',source:'tool'},Date.now()))}finally{await sql.close()}
  const next=await store.prepare({head:runtime.compositeHead(),sourceFiles:{'memory.db':f.local,'new-memories.json':join(f.paths.dataRoot,'new-memories.json'),'persona-versions.json':join(f.paths.dataRoot,'persona-versions.json'),'ledger.jsonl':join(aiDir,'ledger.jsonl')}})
  const secret='SYNTHETIC SYNC KEY FOR REAL ADAPTER TEST',withSourceFence=({holder,term},fn)=>f.lease.fenced(holder,term,db=>{assert.equal(db.prepare('SELECT home FROM tide_head').get().home,holder);return fn()})
  const packet=createSyncDelta({baseDirectory:result.directory,nextDirectory:next.directory,baseHead:result.head,nextHead:next.head,op:'real-four-store-delta',holder:'local',term:f.term,target:'cloud',secret,withSourceFence,readCurrentComposite:()=>runtime.compositeHead()})
  const incoming=join(f.root,'real-incoming');mkdirSync(incoming)
  const received=await stageSyncDelta({packet,baseDirectory:result.directory,expectedBase:result.head,stagingDirectory:incoming,secret,withSourceFence,verifyGeneration})
  assert.equal(received.head.digest,next.head.digest);assert.equal(received.head.sqlite.revision,1);assert.equal(received.head.json.revision,2);assert.equal(received.head.persona.revision,2);assert.equal(received.head.aiMemory.revision,2);assert.equal(verifyGeneration(result.directory).digest,result.head.digest);assert.equal(store.current(),null)
  const network=await authorityHttpFixture({storageFixture:f})
  try{const journal=join(f.root,'real-materializer-journal');mkdirSync(journal);const worker=createMaterializerWorker({target:'cloud',authority:network.cloud,secret,materializerKey:httpKeys.cloud,journalDirectory:journal,stagingDirectory:incoming,verifyGeneration})
   const signed=await worker.receive({packet,baseDirectory:result.directory,expectedBase:result.head});assert.equal(signed.confirmed,true);assert.equal(signed.headDigest,next.head.digest);assert.equal((await network.local.request('/sync/status',{op:packet.op})).accepted,true);assert.equal(f.gateway.head(f.lease).home,'local')
  }finally{await network.cleanup()}

 }finally{await f.cleanup()}
})
