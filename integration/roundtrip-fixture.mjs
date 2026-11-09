// Synthetic continuous history, one fixed authority. No production paths or second lease DB.
import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {MemoryStore} from '../host/plugin/src/store.js'
import * as replica from '../TideMind/deploy/existing/tide-replica.mjs'
import {createStateTransferFixture,slots,secret,sha,syntheticOriginals} from './state-transfer-fixture.mjs'
import {authorityHttpFixture,keys} from './authority-http-fixture.mjs'
import {receiveSyntheticState} from './state-transfer-receiver.mjs'
import {createIdentityBinding} from './identity-binding.mjs'
import {createPersonaVersions} from './persona-versions.mjs'
import {createProtectedJsonMemory} from './protected-json-memory.mjs'
import {createProtectedAiMemory} from './protected-ai-memory.mjs'
import {createGenerationVerifier} from './generation-verifier.mjs'
import {createReplicaGenerations} from './replica-generation.mjs'
import {prepareStoreOperation} from './store-adapter.mjs'
import {prepareSyncDeltaBody,describeSealedDelta} from './sync-delta.mjs'
import {createMaterializerWorker} from './materializer-worker.mjs'
export const ack=head=>({revision:head.sqlite.revision,hash:head.sqlite.hash,data_hash:head.sqlite.dataHash,baseline_hash:head.sqlite.baseline,protected_hash:head.sqlite.protectedHash,composite:head})
const copy=(from,to)=>{mkdirSync(to);for(const n of slots)writeFileSync(join(to,n),readFileSync(join(from,n)))}
const proofError=e=>e.status===409
const handoverBody=(op,term,target,sourceAck,targetAck)=>({op,ticketId:op,term,target,expectedRevision:sourceAck.revision,expectedHash:sourceAck.hash,sourceAck,targetAck})
export async function createWindowsRoundtrip(){
 const f=await createStateTransferFixture(),previous=process.env.TIDEMIND_SYNC_SIGNING_KEY;process.env.TIDEMIND_SYNC_SIGNING_KEY=secret
 let network,phase='forward',returnCandidate,cloudHead
 try{
  network=await authorityHttpFixture({storageFixture:f})
  async function releaseForward(received){
   if(phase!=='forward')throw Error('forward stage already consumed');phase='releasing'
   assert.equal(received.headDigest,f.next.head.digest);const status=await network.local.request('/sync/status',{op:f.capsule.packet.op});assert.equal(status.accepted,true)
   const a=ack(f.next.head),op='roundtrip-forward'
   await network.local.request('/transfer/begin',{op,term:f.term,target:'cloud',baseDigest:f.base.head.digest,sourceAck:a})
   await network.local.request('/transfer/confirm',{term:f.term,ticketId:op,receiptOp:f.capsule.packet.op,sourceAck:a})
   await network.local.request('/transfer/pause',{op,term:f.term});await network.local.request('/transfer/freeze',{op,term:f.term});await network.local.request('/transfer/seal',{op,term:f.term,head:f.next.head})
   await network.local.request('/transfer/handover',handoverBody(op,f.term,'cloud',a,a));phase='cloud'
   assert.equal((await network.local.request('/admin',{command:'renew',term:f.term})).ok,false)
   return {released:true,previousTerm:f.term,headDigest:f.next.head.digest}
  }
  async function receiveReturn(payload,{loseReceiptResponse=false}={}){
   if(phase!=='cloud')throw Error('cloud stage required');phase='receiving'
   cloudHead=payload.head;assert.equal(cloudHead.sqlite.revision,2);for(const k of ['json','persona','aiMemory'])assert.equal(cloudHead[k].revision,3)
   const incoming=join(f.root,'return-incoming'),journal=join(f.root,'return-journal');mkdirSync(incoming);mkdirSync(journal);let submitted=0,lost=false
   const authority={request:async(path,body)=>{if(path==='/sync/receipt')submitted++;const result=await network.local.request(path,body);if(path==='/sync/receipt'&&loseReceiptResponse&&!lost){lost=true;throw Error('SYNTHETIC LOST RETURN RECEIPT RESPONSE')}return result}}
   const worker=createMaterializerWorker({target:'local',authority,secret,materializerKey:keys.local,journalDirectory:journal,stagingDirectory:incoming,verifyGeneration:f.verify})
   const args={packet:payload.packet,baseDirectory:f.next.directory,expectedBase:f.next.head,ticketId:payload.ticketId}
   // A newer/divergent target must never be silently overwritten.
   await assert.rejects(worker.receive({...args,expectedBase:cloudHead}),/target base differs/)
   const tampered=structuredClone(payload.packet);tampered.files['new-memories.json'].insert='eA=='
   await assert.rejects(worker.receive({...args,packet:tampered}),/signature invalid/)
   returnCandidate=await worker.receive(args);assert.equal(returnCandidate.confirmed,true);assert.equal((await worker.receive(args)).confirmed,true);assert.equal(submitted,1)
   assert.equal(f.verify(returnCandidate.directory).digest,cloudHead.digest);f.assertOriginals();phase='received'
   return {targetAck:ack(f.verify(returnCandidate.directory)),receiptConfirmed:true,receiptSubmissions:submitted,responseLossInjected:lost,oldLocalTerm:f.term}
  }
  async function activateReturned(){
   if(phase!=='received')throw Error('verified return candidate required');phase='activating'
   const grant=await network.local.request('/admin',{command:'acquire'});assert.equal(grant.ok,true);assert.equal(grant.term,3)
   const head=await network.local.request('/head',{});assert.equal(head.home,'local');assert.equal(head.revision,2);assert.equal(head.hash,cloudHead.sqlite.hash)
   const generations=join(f.root,'returned-generations'),working=join(f.root,'returned-working');mkdirSync(generations);copy(returnCandidate.directory,working)
   const store=createReplicaGenerations({directory:generations,verifyGeneration:f.verify}),sources=dir=>Object.fromEntries(slots.map(n=>[n,join(dir,n)]))
   const original=await store.prepare({sourceFiles:sources(f.next.directory),head:f.next.head}),returned=await store.prepare({sourceFiles:sources(working),head:cloudHead})
   await store.select({id:original.id});await store.select({id:returned.id,expectedCurrent:{id:original.id}})
   await assert.rejects(store.select({id:original.id,expectedCurrent:{id:returned.id}}),/newer, branched/)
   const op='local-after-return',before=replica.replicaHead(join(working,'memory.db'))
   const planned=await prepareStoreOperation(join(working,'memory.db'),{method:'write',args:[{layer:'semantic',content:'SYNTHETIC LOCAL AFTER CLOUD RETURN',source:'tool'}],now:4},{MemoryStore:f.MemoryStore,commitContext:{op,holder:'local',term:grant.term,revision:before.revision,hash:before.hash}})
   await network.local.request('/commit',{op,term:grant.term,expectedRevision:before.revision,expectedHash:before.hash,mutation:planned.batch})
   const entries=await network.local.request('/entries',{after:before.revision}),latest=await network.local.request('/head',{});replica.materialize(join(working,'memory.db'),entries.entries,{expected:before,sourceHead:latest,home:'local'})
   const finalHead=f.verify(working),final=await store.prepare({sourceFiles:sources(working),head:finalHead});await store.select({id:final.id,expectedCurrent:{id:returned.id}})
   const reopened=createReplicaGenerations({directory:generations,verifyGeneration:f.verify});assert.equal((await reopened.inspect(reopened.current().id)).head.digest,finalHead.digest)
   const db=new DatabaseSync(join(final.directory,'memory.db'),{readOnly:true});try{for(const content of ['SYNTHETIC CROSS MACHINE NEW SQLITE','SYNTHETIC CLOUD NEW SQLITE','SYNTHETIC LOCAL AFTER CLOUD RETURN'])assert.equal(db.prepare('SELECT count(*) n FROM memories WHERE content=?').get(content).n,1)}finally{db.close()}
   assert.ok(JSON.parse(readFileSync(join(final.directory,'new-memories.json'),'utf8')).items.some(x=>x.id==='json-cloud'))
   assert.ok(JSON.parse(readFileSync(join(final.directory,'persona-versions.json'),'utf8')).versions.some(x=>x.persona.body.includes('SYNTHETIC CLOUD NEW PERSONA VERSION')))
   assert.ok(readFileSync(join(final.directory,'ledger.jsonl'),'utf8').includes('SYNTHETIC CLOUD NEW AI'))
   f.assertOriginals();phase='done'
   return {passed:true,continuousHistory:true,cloudNewWriteMerged:true,allFourCloudRecordsVerified:true,protectedOriginalsUnchanged:true,termSequence:[1,2,3],finalRevisions:Object.fromEntries(['sqlite','json','persona','aiMemory'].map(k=>[k,finalHead[k].revision])),restartReopenPassed:true,staleGenerationRejected:true,productionEnabled:false}
  }
  return {...f,network,releaseForward,receiveReturn,activateReturned,cleanup:async()=>{await network.cleanup();f.cleanup();if(previous===undefined)delete process.env.TIDEMIND_SYNC_SIGNING_KEY;else process.env.TIDEMIND_SYNC_SIGNING_KEY=previous}}
 }catch(e){if(network)await network.cleanup();f.cleanup();if(previous===undefined)delete process.env.TIDEMIND_SYNC_SIGNING_KEY;else process.env.TIDEMIND_SYNC_SIGNING_KEY=previous;throw e}
}
export async function createCloudRoundtrip({root,capsule,authority}){
 const forward=await receiveSyntheticState({root,capsule,authority,returnDirectory:true}),source=join(root,'synthetic-originals'),pins={persona:sha(syntheticOriginals.persona),jsonMemory:sha(syntheticOriginals.json)},verify=createGenerationVerifier({ownedRoot:root,sourceDataRoot:source,selectedPersona:'synthetic',pins,aiSource:join(source,'ai-original.jsonl'),aiBaselineSha256:sha(syntheticOriginals.ai)})
 let phase='received',grant,next,forbidden
 const guard=fn=>{if(phase!=='active')throw Error('cloud source writes paused');return fn()}
 async function advance({loseSigningResponse=false}={}){
  if(phase!=='received')throw Error('cloud advance already started');phase='acquiring'
  grant=await authority.request('/admin',{command:'acquire'});assert.equal(grant.ok,true);assert.equal(grant.term,2);phase='active'
  const working=join(root,'cloud-working');copy(forward.directory,working)
  const json=createProtectedJsonMemory({source:join(source,'memories.json'),expectedSha256:pins.jsonMemory,overlay:join(working,'new-memories.json'),ownedRoot:root,withWriteGuard:guard})
  const persona=createPersonaVersions({identity:createIdentityBinding({directory:join(source,'personas'),selected:'synthetic',expectedSha256:pins.persona}),ownedRoot:root,stateFile:join(working,'persona-versions.json'),withWriteGuard:guard})
  const ai=createProtectedAiMemory({source:join(source,'ai-original.jsonl'),baselineSha256:sha(syntheticOriginals.ai),ownedRoot:root,directory:working,withWriteGuard:guard})
  process.env.TIDEMIND_STORE_SIGNING_KEY='synthetic-test-signing-key-at-least-32-characters'
  const before=replica.replicaHead(join(working,'memory.db')),op='cloud-new-sql'
  const planned=await prepareStoreOperation(join(working,'memory.db'),{method:'write',args:[{layer:'semantic',content:'SYNTHETIC CLOUD NEW SQLITE',source:'tool'}],now:3},{MemoryStore,commitContext:{op,holder:'cloud',term:grant.term,revision:before.revision,hash:before.hash}})
  await authority.request('/commit',{op,term:grant.term,expectedRevision:before.revision,expectedHash:before.hash,mutation:planned.batch})
  const entries=await authority.request('/entries',{after:before.revision}),head=await authority.request('/head',{});replica.materialize(join(working,'memory.db'),entries.entries,{expected:before,sourceHead:head,home:'cloud'})
  const memory=json.load();memory.items.push({id:'json-cloud',text:'SYNTHETIC CLOUD NEW JSON'});json.save(memory);const person=persona.readPersona();persona.savePersona(person.id,{...person,body:person.body+' SYNTHETIC CLOUD NEW PERSONA VERSION'});ai.operations.write({kind:'insight',text:'SYNTHETIC CLOUD NEW AI'})
  const nextHead=verify(working),generations=join(root,'cloud-generations');mkdirSync(generations);const store=createReplicaGenerations({directory:generations,verifyGeneration:verify});next=await store.prepare({sourceFiles:Object.fromEntries(slots.map(n=>[n,join(working,n)])),head:nextHead})
  const forbiddenOp='cloud-write-after-freeze',forbiddenPlan=await prepareStoreOperation(join(working,'memory.db'),{method:'write',args:[{layer:'semantic',content:'SYNTHETIC FORBIDDEN POST FREEZE',source:'tool'}],now:5},{MemoryStore,commitContext:{op:forbiddenOp,holder:'cloud',term:grant.term,revision:head.revision,hash:head.hash}})
  forbidden={op:forbiddenOp,term:grant.term,expectedRevision:head.revision,expectedHash:head.hash,mutation:forbiddenPlan.batch}
  phase='sealed';assert.throws(()=>json.save(json.load()),/writes paused/);assert.throws(()=>persona.savePersona(person.id,person),/writes paused/);assert.throws(()=>ai.operations.write({kind:'insight',text:'SYNTHETIC BLOCKED'}),/writes paused/)
  const ticketId='roundtrip-return',body=prepareSyncDeltaBody({baseDirectory:forward.directory,nextDirectory:next.directory,baseHead:capsule.nextHead,nextHead,op:ticketId,holder:'cloud',term:grant.term,target:'local',mode:'handover'}),descriptor=describeSealedDelta(body)
  await assert.rejects(authority.request('/sync/sign',{ticketId,descriptor}),proofError)
  await authority.request('/transfer/begin',{op:ticketId,term:grant.term,target:'local',baseDigest:capsule.nextHead.digest,sourceAck:ack(nextHead)})
  await authority.request('/transfer/pause',{op:ticketId,term:grant.term});await authority.request('/transfer/freeze',{op:ticketId,term:grant.term});await authority.request('/transfer/seal',{op:ticketId,term:grant.term,head:nextHead})
  await assert.rejects(authority.request('/commit',forbidden),proofError)
  let proof=await authority.request('/sync/sign',{ticketId,descriptor})
  if(loseSigningResponse){const retry=await authority.request('/sync/sign',{ticketId,descriptor});assert.deepEqual(retry,proof);proof=retry}
  return {packet:{...body,...proof},ticketId,head:nextHead,cloudNewWriteCreated:true,term:grant.term,sourceWritesBlocked:true,signingReplayVerified:loseSigningResponse}
 }
 async function finish(received,{loseHandoverResponse=false}={}){
  if(phase!=='sealed')throw Error('sealed source required');assert.equal(received.receiptConfirmed,true);const ticketId='roundtrip-return',a=ack(next.head)
  await authority.request('/transfer/confirm',{term:grant.term,ticketId,receiptOp:ticketId,sourceAck:a})
  await assert.rejects(authority.request('/transfer/handover',handoverBody(ticketId,grant.term,'local',a,ack(capsule.nextHead))),proofError)
  assert.equal((await authority.request('/head',{})).home,'cloud');assert.equal((await authority.request('/admin',{command:'status'})).holder,'cloud')
  await authority.request('/transfer/handover',handoverBody(ticketId,grant.term,'local',a,received.targetAck));phase='transferred'
  // If the reply was lost, inspect state, never issue a blind second handover.
  if(loseHandoverResponse){const current=await authority.request('/head',{}),lease=await authority.request('/admin',{command:'status'});assert.equal(current.home,'local');assert.equal(current.revision,next.head.sqlite.revision);assert.equal(current.hash,next.head.sqlite.hash);assert.equal(lease.holder,null)}
  await assert.rejects(authority.request('/commit',forbidden),proofError)
  return {released:true,wrongAckRejected:true,oldCloudWriteRejected:true,handoverResponseRecoveredByStatus:loseHandoverResponse}
 }
 return {forward,advance,finish}
}
