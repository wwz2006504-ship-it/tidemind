import {test} from 'node:test'
import assert from 'node:assert/strict'
import {keys} from './authority-http-fixture.mjs'
import {remoteRuntimeFixture} from './remote-runtime-fixture.mjs'
import {captureSessionHistoryBundle,createSessionHistoryBundle,assertSessionBundleExtension,materializeSessionHistoryBundle} from './session-history-bundle.mjs'
import {createSessionHistoryAuthority,signHistoryFrontier,assertHistoryAckAgreement} from './session-history-authority.mjs'
import {mkdirSync,copyFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {DatabaseSync,backup} from 'node:sqlite'
import {createGenerationVerifier} from './generation-verifier.mjs'
import {createSyncDelta,prepareSyncDeltaBody,describeSealedDelta,signSealedReverseDelta} from './sync-delta.mjs'
import {createMaterializerWorker} from './materializer-worker.mjs'
import {openNativeSessionStorage} from './native-session-storage.mjs'
import {createSyncReceipts} from './sync-receipts.mjs'
import {freezeStoppedSessionHistory} from './session-history-freeze.mjs'
import {mapSessionWorkspaces} from './session-history-transfer.mjs'
import * as fenced from './fenced-store.mjs'
async function appendSyntheticHistory(bundle,sessionId,root,openPersistence=openNativeSessionStorage){
 const working=await materializeSessionHistoryBundle({source:bundle,expectedDigest:bundle.digest,root,openPersistence})
 const storage=await openPersistence(working.directory)
 try{
  const writer=await storage.persistence.open(sessionId,'write')
  try{
   const {events}=await writer.read(0)
   await writer.append([{seq:events.length,time:Date.now(),type:'user/message',data:{id:'synthetic-cloud-history',role:'user',content:[{type:'text',text:'SYNTHETIC CLOUD HISTORY EVENT'}],source:{kind:'aurabot',origin:'qq-user'}},surfaceOp:'append'}]);await writer.flush()
  }finally{await writer.close()}
  return await captureSessionHistoryBundle({persistence:storage.persistence,mappings:bundle.mappings,previous:bundle})
 }finally{await storage.close()}
}
function appendOnStagedCloud(bundle,sessionId){
 const digest=process.env.TIDEMIND_TEST_CLOUD_CANDIDATE
 if(!/^[a-f0-9]{64}$/.test(digest))throw Error('reviewed staging candidate digest required')
 const root='/srv/tidemind-staging',candidate=`${root}/candidates/${digest}`
 const script=`
 import {readFileSync,mkdtempSync,rmSync,realpathSync,mkdirSync} from 'node:fs';
 import {dirname,join,isAbsolute,win32,posix} from 'node:path';
 import {pathToFileURL} from 'node:url';
 const {captureSessionHistoryBundle,materializeSessionHistoryBundle}=await import(pathToFileURL(process.cwd()+'/integration/session-history-bundle.mjs'));
 const {openNativeSessionStorage}=await import(pathToFileURL(process.cwd()+'/integration/native-session-storage.mjs'));
 const {hash}=await import(pathToFileURL(process.cwd()+'/TideMind/deploy/existing/tide-gateway.mjs'));
 const {checkedPath}=await import(pathToFileURL(process.cwd()+'/TideMind/deploy/existing/tide-replica.mjs'));
 if(readFileSync('${root}/OWNER','utf8')!=='TideMind candidate staging v1')throw Error('staging ownership differs');
 const sandbox=mkdtempSync('${root}/history-roundtrip-');
 if(dirname(realpathSync(sandbox))!==realpathSync('${root}'))throw Error('sandbox escaped staging');
 process.env.TIDEMIND_SANDBOX_ROOT=sandbox;
 process.env.TIDEMIND_APP_MODULES='${root}/dsh-sdk/6bb92f34c39fda81d51437e3c2b322a806e961d57ffc6c8647321f5e1673a655/node_modules/@deepseek-ai';
 try{
  const {bundle,sessionId}=JSON.parse(readFileSync(0,'utf8'));
  const open=async directory=>{
   const backend=await openNativeSessionStorage(directory);
   try{return {persistence:(${mapSessionWorkspaces.toString()})(backend.persistence,bundle.sessions.map(s=>s.header),sandbox+'/workspace'),close:()=>backend.close()}}
   catch(error){await backend.close();throw error}
  };
  console.log(JSON.stringify(await (${appendSyntheticHistory.toString()})(bundle,sessionId,sandbox+'/working',open)));
 }catch(error){console.error(error.name+': '+error.message);process.exitCode=1}
 finally{rmSync(sandbox,{recursive:true,force:true})}`
 const encoded=Buffer.from(script).toString('base64')
 const command=`cd ${candidate}/source && test ! -e ../DISABLED && ${root}/runtime/node-v24.17.0-linux-x64/node --input-type=module -e "await import('data:text/javascript;base64,${encoded}')"`
 return JSON.parse(execFileSync('ssh',['-i',process.env.TIDEMIND_TEST_CLOUD_KEY,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+process.env.TIDEMIND_TEST_CLOUD_KNOWN_HOSTS,'-o','ConnectTimeout=10','root@CLOUD_HOST_PLACEHOLDER',command],{input:JSON.stringify({bundle,sessionId}),encoding:'utf8',timeout:45000,windowsHide:true}))
}
async function setup({withChat=false}={}){
 const f=await remoteRuntimeFixture(),r=await f.start()
 if(withChat){await f.emit(f.event(79501));for(let i=0;i<300&&(f.agent.status!=='idle'||f.remoteSent.length===0);i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.remoteSent.length,1);await r.host.transferLifecycle.drainSessionEvents();await fenced.drain()}
 await f.ctx.sessions.flush(f.agent.session);await f.ctx.sessions.flush(r.driver.agent.session)
 const mappings={'private:20001':{sessionId:f.agent.id,preset:'aurabot-private',level:'full'},'system:cognitive':{sessionId:r.driver.agent.id,preset:'aurabot-private',level:'full'}}
 const bundle=await captureSessionHistoryBundle({persistence:f.ctx.sessionPersistence,mappings}),head=await r.compositeHead(),s=head.sqlite,ack={revision:s.revision,hash:s.hash,data_hash:s.dataHash,baseline_hash:s.baseline,protected_hash:s.protectedHash,composite:head}
 const history=createSessionHistoryAuthority({lease:f.lease,keys,initialDigest:bundle.digest,currentFourHead:()=>head}),op='history-handover'
 const descriptor={op,holder:'local',term:f.term,expectedRevision:0,expectedDigest:null,bundleDigest:bundle.digest,fourDigest:head.digest},signed=signHistoryFrontier(descriptor,keys.local)
 return {...f,r,bundle,ack,history,op,descriptor,signed,async pause(){await r.sourceAdmission.pause(op);await r.sourceAdmission.drain();await r.memoryBarrier.begin(op)}}
}
test('actual original SDK histories publish once under original paused authority and bind matching acknowledgements',async()=>{
 const f=await setup();try{
  await f.pause();const published=f.history.publish('local',f.term,{signed:f.signed,bundle:f.bundle,ack:f.ack}),{replayed,...history}=published
  assert.equal(published.revision,1);assert.equal(published.baseline,f.bundle.digest);assert.equal(f.history.publish('local',f.term,{signed:f.signed,bundle:f.bundle,ack:f.ack}).replayed,true)
  const ack={...f.ack,history};f.lease.fenced('local',f.term,db=>assertHistoryAckAgreement(db,{sourceAck:ack,targetAck:ack,holder:'local',term:f.term,op:f.op,required:true}))
  assert.throws(()=>f.lease.fenced('local',f.term,db=>assertHistoryAckAgreement(db,{sourceAck:ack,targetAck:{...ack,history:{...history,digest:'f'.repeat(64)}},holder:'local',term:f.term,op:f.op})),/histories differ/)
  assert.throws(()=>f.gateway.handover(f.lease,'local',f.term,{op:f.op,target:'cloud',expectedRevision:f.ack.revision,expectedHash:f.ack.hash,sourceAck:f.ack,targetAck:f.ack}),/history acknowledgement missing/)
 }finally{await f.cleanup()}
})

test('original materializer signs history receipt only after native SDK reconstruction and binds final handover',async()=>{
 const f=await setup({withChat:true});let frozen;try{
  const base=join(f.root,'four-history-base'),stage=join(f.root,'four-history-stage'),journal=join(f.root,'four-history-journal');for(const p of [base,stage,journal])mkdirSync(p)
  const db=new DatabaseSync(f.local,{readOnly:true});try{await backup(db,join(base,'memory.db'))}finally{db.close()}
  for(const name of ['new-memories.json','persona-versions.json','ledger.jsonl'])copyFileSync(join(f.paths.dataRoot,'remote-sidecars',name),join(base,name))
  const verify=createGenerationVerifier({ownedRoot:f.root,sourceDataRoot:f.paths.sourceDataRoot,selectedPersona:'synthetic',pins:f.spec.pins,aiSource:f.spec.aiMemory.source,aiBaselineSha256:f.spec.aiMemory.baselineSha256})
  assert.equal(verify(base).digest,f.ack.composite.digest)
  assert.equal((await f.r.transfer.drain(f.op)).drained,true)
  await f.r.memoryBarrier.begin(f.op)
  frozen=await freezeStoppedSessionHistory({ctx:f.ctx,mappings:f.bundle.mappings,historyRoot:join(f.root,'sessions'),stopRuntime:async()=>{await f.r.close();await f.closeRuntime()}})
  assert.equal(f.lease.status().term,f.term)
  assert.equal(frozen.bundle.digest,f.bundle.digest)
  f.history.publish('local',f.term,{signed:f.signed,bundle:await frozen.snapshot(),ack:f.ack})
  const history=f.history.current().head,ack={...f.ack,history},head=f.ack.composite,secret='SYNTHETIC HISTORY SYNC SIGNING KEY 123456789'
  const packet=createSyncDelta({baseDirectory:base,nextDirectory:base,baseHead:head,nextHead:head,op:f.op,holder:'local',term:f.term,target:'cloud',secret,history:{head:history,bundle:f.bundle,baseDigest:null},withSourceFence:({holder,term},fn)=>f.lease.fenced(holder,term,fn),readCurrentComposite:()=>head})
  const receipts=createSyncReceipts({lease:f.lease,materializerKeys:keys});receipts.begin({holder:'local',term:f.term,op:f.op,target:'cloud',baseDigest:head.digest,sourceAck:ack})
  await f.r.memoryBarrier.seal(f.op,()=>head)
  const common={target:'cloud',authority:f.network.cloud,secret,materializerKey:keys.cloud,journalDirectory:journal,stagingDirectory:stage,verifyGeneration:verify}
  await assert.rejects(createMaterializerWorker(common).receive({packet,baseDirectory:base,expectedBase:head}),/actual destination history reader/)
  const updated=structuredClone(f.bundle.sessions[0]);updated.events.push({seq:updated.events.length,time:Date.now(),type:'user/message',data:{id:'synthetic-newer-target',role:'user',content:[{type:'text',text:'SYNTHETIC NEWER DESTINATION'}],source:{kind:'aurabot',origin:'qq-user'}},surfaceOp:'append'})
  const {digest:oldDigest,...updatedBody}=updated,{hash}=await import('../TideMind/deploy/existing/tide-gateway.mjs');updated.digest=hash(updatedBody)
  const newer=createSessionHistoryBundle({sessions:f.bundle.sessions.map((s,i)=>i===0?updated:s),mappings:f.bundle.mappings})
  await assert.rejects(createMaterializerWorker({...common,history:{readCurrent:async()=>newer,openPersistence:openNativeSessionStorage}}).receive({packet,baseDirectory:base,expectedBase:head}),/destination history base differs/)
  let lost=false,submissions=0
  const authority={request:async(path,body)=>{if(path==='/sync/receipt')submissions++;const result=await f.network.cloud.request(path,body);if(path==='/sync/receipt'&&!lost){lost=true;throw Error('SYNTHETIC HISTORY RECEIPT ACK LOST')}return result}}
  const worker=createMaterializerWorker({...common,authority,history:{readCurrent:async()=>null,openPersistence:openNativeSessionStorage}})
  const result=await worker.receive({packet,baseDirectory:base,expectedBase:head});assert.equal(result.confirmed,true);assert.equal(result.historyDigest,f.bundle.digest)
  const stored=await openNativeSessionStorage(result.historyDirectory);try{const restored=await captureSessionHistoryBundle({persistence:stored.persistence,mappings:f.bundle.mappings});assert.equal(restored.digest,f.bundle.digest);assert.ok(restored.sessions.some(s=>s.events.some(e=>e.type==='assistant/message')))}finally{await stored.close()}
  assert.equal((await worker.receive({packet,baseDirectory:base,expectedBase:head})).confirmed,true);assert.equal(submissions,1);assert.equal(lost,true)
  receipts.confirm({holder:'local',term:f.term,ticketId:f.op,receiptOp:f.op,sourceAck:ack})
  await f.r.close()
  assert.equal(f.gateway.handover(f.lease,'local',f.term,{op:f.op,target:'cloud',ticketId:f.op,expectedRevision:f.ack.revision,expectedHash:f.ack.hash,sourceAck:ack,targetAck:ack}).ok,true)
  assert.equal(f.lease.status().holder,null);assert.equal(f.gateway.head(f.lease).home,'cloud')
  const grant=await f.network.cloud.request('/admin',{command:'acquire'});assert.equal(grant.ok,true)
  const extended=process.env.TIDEMIND_TEST_CLOUD_CANDIDATE?appendOnStagedCloud(f.bundle,f.agent.id):await appendSyntheticHistory(f.bundle,f.agent.id,join(f.root,'cloud-history-working'))
  assert.equal(assertSessionBundleExtension(f.bundle,extended).appended,1)
  const op='history-return',term=grant.term
  await f.network.cloud.request('/transfer/pause',{op,term});await f.network.cloud.request('/transfer/freeze',{op,term})
  const signed=signHistoryFrontier({op,holder:'cloud',term,expectedRevision:history.revision,expectedDigest:history.digest,bundleDigest:extended.digest,fourDigest:head.digest},keys.cloud)
  f.history.publish('cloud',term,{signed,bundle:extended,ack:f.ack})
  const reverseHead=f.history.current().head,reverseAck={...f.ack,history:reverseHead}
  receipts.begin({holder:'cloud',term,op,target:'local',baseDigest:head.digest,sourceAck:reverseAck})
  await f.network.cloud.request('/transfer/seal',{op,term,head})
  const body=prepareSyncDeltaBody({baseDirectory:base,nextDirectory:base,baseHead:head,nextHead:head,op,holder:'cloud',term,target:'local',mode:'handover',history:{head:reverseHead,bundle:extended,baseDigest:f.bundle.digest}})
  const proof=signSealedReverseDelta({lease:f.lease,principal:'cloud',body:describeSealedDelta(body),ticketId:op,secret,authorizeHandover:input=>receipts.authorizeReverse({ticketId:op,...input})})
  const returnStage=join(f.root,'return-history-stage'),returnJournal=join(f.root,'return-history-journal');mkdirSync(returnStage);mkdirSync(returnJournal)
  const receiver=createMaterializerWorker({...common,target:'local',authority:f.network.local,materializerKey:keys.local,journalDirectory:returnJournal,stagingDirectory:returnStage,history:{readCurrent:()=>frozen.snapshot(),openPersistence:openNativeSessionStorage}})
  const returned=await receiver.receive({packet:{...body,...proof},baseDirectory:base,expectedBase:head,ticketId:op})
  assert.equal(returned.confirmed,true);assert.equal(returned.historyDigest,extended.digest)
  receipts.confirm({holder:'cloud',term,ticketId:op,receiptOp:op,sourceAck:reverseAck})
  assert.equal(f.gateway.handover(f.lease,'cloud',term,{op,target:'local',ticketId:op,expectedRevision:f.ack.revision,expectedHash:f.ack.hash,sourceAck:reverseAck,targetAck:reverseAck}).ok,true)
  assert.equal(f.gateway.head(f.lease).home,'local')
  const reopened=await openNativeSessionStorage(returned.historyDirectory)
  try{assert.equal((await captureSessionHistoryBundle({persistence:reopened.persistence,mappings:f.bundle.mappings})).digest,extended.digest)}finally{await reopened.close()}
 }finally{await frozen?.release();await f.cleanup()}
})
test('unpaused source, forged frontier and stale expected history never overwrite canonical history',async()=>{
 const f=await setup();try{
  assert.throws(()=>f.history.publish('local',f.term,{signed:f.signed,bundle:f.bundle,ack:f.ack}),/paused drained/)
  await f.pause();assert.throws(()=>f.history.publish('local',f.term,{signed:{...f.signed,proof:'a'.repeat(64)},bundle:f.bundle,ack:f.ack}),/signed original/)
  f.history.publish('local',f.term,{signed:f.signed,bundle:f.bundle,ack:f.ack})
  const stale=signHistoryFrontier({...f.descriptor,expectedRevision:0,expectedDigest:'b'.repeat(64)},keys.local)
  assert.throws(()=>f.history.publish('local',f.term,{signed:stale,bundle:f.bundle,ack:f.ack}),/newer history/);assert.equal(f.history.current().head.revision,1)
 }finally{await f.cleanup()}
})
test('history bundle retains retired daily sessions and refuses missing history or privilege changes',async()=>{
 const f=await setup();try{
  const original=f.bundle.sessions.find(s=>s.header.id===f.agent.id),future=structuredClone(original);future.header.id='synthetic-next-day';future.header.createdAt++;const {digest,...body}=future
  const {hash}=await import('../TideMind/deploy/existing/tide-gateway.mjs');future.digest=hash(body)
  const mappings={...f.bundle.mappings,'private:20001':{...f.bundle.mappings['private:20001'],sessionId:future.header.id}},next=createSessionHistoryBundle({sessions:[...f.bundle.sessions,future],mappings})
  assert.equal(assertSessionBundleExtension(f.bundle,next).baseDigest,f.bundle.digest)
  const missing=createSessionHistoryBundle({sessions:next.sessions.filter(s=>s.header.id!==original.header.id),mappings});assert.throws(()=>assertSessionBundleExtension(f.bundle,missing),/retired original session missing/)
  const changed=createSessionHistoryBundle({sessions:next.sessions,mappings:{...mappings,'private:20001':{...mappings['private:20001'],level:'social',preset:'aurabot-social'}}});assert.throws(()=>assertSessionBundleExtension(f.bundle,changed),/privilege mapping changed/)
 }finally{await f.cleanup()}
})

test('first handover accepts fresh history extending reviewed baseline and refuses rewritten history',async()=>{
 const f=await setup();try{
  const baseline=structuredClone(f.bundle),history=createSessionHistoryAuthority({lease:f.lease,keys,initialDigest:baseline.digest,initialBundle:baseline,currentFourHead:()=>f.ack.composite})
  assert.throws(()=>createSessionHistoryAuthority({lease:f.lease,keys,initialDigest:'f'.repeat(64),initialBundle:baseline,currentFourHead:()=>f.ack.composite}),/baseline bundle differs/)
  // A caller cannot mutate the reviewed baseline after authority construction.
  baseline.sessions.length=0
  const {hash}=await import('../TideMind/deploy/existing/tide-gateway.mjs')
  const updated=structuredClone(f.bundle.sessions[0]);updated.events.push({seq:updated.events.length,time:Date.now(),type:'user/message',data:{id:'fresh-before-cutover',role:'user',content:[{type:'text',text:'SYNTHETIC FRESH EVENT'}],source:{kind:'aurabot',origin:'qq-user'}},surfaceOp:'append'})
  const {digest,...body}=updated;updated.digest=hash(body)
  const next=createSessionHistoryBundle({sessions:f.bundle.sessions.map((s,i)=>i===0?updated:s),mappings:f.bundle.mappings})
  await f.pause()
  const bad=structuredClone(updated);bad.header.createdAt++;const {digest:badDigest,...badBody}=bad;bad.digest=hash(badBody)
  const fork=createSessionHistoryBundle({sessions:f.bundle.sessions.map((s,i)=>i===0?bad:s),mappings:f.bundle.mappings})
  const publish=bundle=>history.publish('local',f.term,{signed:signHistoryFrontier({...f.descriptor,bundleDigest:bundle.digest},keys.local),bundle,ack:f.ack})
  assert.throws(()=>publish(fork));assert.equal(history.current().found,false)
  const accepted=publish(next);assert.equal(accepted.baseline,f.bundle.digest);assert.equal(accepted.digest,next.digest);assert.equal(accepted.revision,1)
 }finally{await f.cleanup()}
})
