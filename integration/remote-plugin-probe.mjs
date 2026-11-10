// Real installed DSH Controller/AgentLoop + original memory plugin, SYNTHETIC cloud authority.
// Secret lab client capsule arrives only on stdin, never in command arguments/logs.
import {createInterface} from 'node:readline'
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync,readdirSync,realpathSync} from 'node:fs'
import {join,relative,isAbsolute} from 'node:path'
import {DatabaseSync,backup} from 'node:sqlite'
import assert from 'node:assert/strict'
import {dataRoot} from './fixture.mjs'
import * as replica from '../TideMind/deploy/existing/tide-replica.mjs'
import {loadLiveStoreClass} from './store-adapter.mjs'
import {createAuthorityClient} from './authority-client.mjs'
import {createRemoteStoreExecutor} from './remote-store-executor.mjs'
import {controllerHost} from './controller-host.mjs'
import * as fenced from './fenced-store.mjs'
import * as memory from '../host/plugin/src/index.js'
import {createRemoteSidecars} from './remote-sidecars.mjs'
import {remoteOperationId} from './remote-operation-scope.mjs'
import {mountRemoteSidecarTools} from './remote-sidecar-tools.mjs'
import {sha} from './state-transfer-fixture.mjs'
import {createGenerationVerifier} from './generation-verifier.mjs'
const args=process.argv.slice(2)
if(args.includes('--dry-run')||args.includes('--rollback'))console.log(JSON.stringify({dryRun:args.includes('--dry-run'),rollback:args.includes('--rollback'),productionEnabled:false,scope:'synthetic mirror only; no production profile installation'}))
else{
 for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  if(line.length>2*1024*1024)throw Error('bounded lab capsule required');const capsule=JSON.parse(line)
  if(capsule.tag!=='TideMind isolated authority lab v1')throw Error('synthetic lab capsule required')
  mkdirSync(dataRoot,{recursive:true});const root=mkdtempSync(join(dataRoot,'cloud-plugin-probe-')),localDir=join(root,'local'),journal=join(root,'remote-journal');mkdirSync(localDir);mkdirSync(journal)
  process.env.TIDEMIND_SANDBOX_ROOT=root;process.env.TIDEMIND_STORE_SIGNING_KEY=capsule.storeSigningKey;delete process.env.TIDEMIND_LEASE_DB
  const local=join(localDir,'memory.db');writeFileSync(local,Buffer.from(capsule.baselineFile,'base64'),{mode:0o600})
  const before=replica.replicaHead(local);assert.equal(before.baseline_hash,capsule.baseline.baseline_hash);assert.equal(before.protected_hash,capsule.baseline.protected_hash)
  let host,fiber,grant,unmount,commits=0,sidecarCommits=0;const client=createAuthorityClient({url:capsule.authorityUrl,token:capsule.localToken}),authority={request:async(path,body)=>{if(path==='/commit')commits++;if(path==='/state/commit')sidecarCommits++;return client.request(path,body)}}
  const cleanup=()=>{const rel=relative(realpathSync(dataRoot),realpathSync(root));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('unsafe synthetic cleanup');rmSync(root,{recursive:true,force:true})}
  try{
   grant=await authority.request('/admin',{command:'acquire',ttl:60000});assert.equal(grant.ok,true)
   const entries=await authority.request('/entries',{after:before.revision}),head=await authority.request('/head',{});replica.materialize(local,entries.entries,{expected:before,sourceHead:head,home:'local'})
   const {MemoryStore}=await loadLiveStoreClass(),read=(sql,...params)=>{const db=new DatabaseSync(local,{readOnly:true});try{return db.prepare(sql).all(...params)}finally{db.close()}}
   const fixture={root,localDir,local,MemoryStore,replica,read,cleanup:()=>{}};const memoryText=capsule.variant==='second'?'合成火山地质熔岩岩石知识':'合成天文望远镜蓝色风铃约定'
   const source=join(root,'synthetic-originals'),side=join(root,'sidecars'),pending=join(root,'sidecar-pending');mkdirSync(source);mkdirSync(join(source,'personas'));mkdirSync(side);mkdirSync(pending)
   const originals=capsule.sidecarOriginals;assert.equal(typeof originals?.persona,'string');writeFileSync(join(source,'personas/synthetic.md'),originals.persona);writeFileSync(join(source,'memories.json'),originals.json);writeFileSync(join(source,'ai-original.jsonl'),originals.ai)
   const spec={sourceDataRoot:source,selectedPersona:'synthetic',pins:{persona:sha(originals.persona),jsonMemory:sha(originals.json)},aiSource:join(source,'ai-original.jsonl'),aiBaselineSha256:sha(originals.ai)}
   const remote=createRemoteSidecars({authority,holder:'local',term:grant.term,ownedRoot:root,directory:side,journalDirectory:pending,spec,getOperationId:remoteOperationId});await remote.initialize()
   const marker=capsule.variant==='second'?'SYNTHETIC 火山熔岩地质岩石记录':'SYNTHETIC 碧蓝风铃望远镜约定',personaAlreadyPresent=remote.persona.readPersona().body.includes(marker+' PERSONA'),calls=[{id:'synthetic-search-v2',name:'lmem_search',args:{query:'麦克风'}},{id:'synthetic-write-v2',name:'lmem_write',args:{layer:'semantic',content:memoryText,tags:'合成'}},{id:'json-v2-'+capsule.variant,name:'remember',args:{text:marker+' JSON'}},{id:'persona-v2-'+capsule.variant,name:personaAlreadyPresent?'persona_read':'persona_edit',args:personaAlreadyPresent?{}:{new_text:marker+' PERSONA'}},{id:'ai-search-v2-'+capsule.variant,name:'memory_search',args:{query:marker}},{id:'ai-v2-'+capsule.variant,name:'memory_write',args:{kind:'insight',text:marker+' AI'}}]
   host=await controllerHost({mode:'scripted-tools',scriptedCalls:calls,mountMemory:false,storageFixture:fixture});unmount=mountRemoteSidecarTools(host,remote)
   const executor=createRemoteStoreExecutor({authority,holder:'local',term:grant.term,local,journalDirectory:journal,MemoryStore})
   fenced.configure({root,localDir,local,remoteStoreExecutor:executor,bindings:[{agentId:host.agent.id,sessionId:host.agent.id,logicalAgentId:'my-agent'}]})
   fiber=host.ctx.plugin({name:'cloud-remote-memory-probe',inject:memory.inject,apply(child){memory.apply(child,{dir:localDir,enabled:true,injectContext:true,autoCapture:false,tideEnabled:false,dailyBackup:false,logRetrieval:false,injectTokenBudget:2000})}});await fiber.await()
   host.agent.followup({id:'synthetic-cloud-plugin-turn',role:'user',content:[{type:'text',text:'麦克风 合成远端宿主写入验证'}],source:{kind:'plugin'}})
   let ended=false
   for(let i=0;i<2000;i++){ended=host.agent.status==='idle'&&host.agent.session.snapshotEvents().some(e=>e.type==='turn/end');if(ended)break;await new Promise(r=>setTimeout(r,5))}
   assert.equal(ended,true);await fenced.drain();await remote.idle();assert.deepEqual(host.errors,[]);assert.equal(executor.pending(),null);assert.equal(remote.pending(),null);assert.equal(read('SELECT count(*) n FROM memories WHERE content=?',memoryText)[0].n,1)
   assert.equal(remote.json.load().items.filter(x=>x.text===marker+' JSON').length,1);assert.ok(remote.persona.readPersona().body.includes(marker+' PERSONA'))
   assert.equal((await remote.aiMemory.operations.search({query:marker+' AI'})).results.filter(x=>x.text===marker+' AI').length,1)
   const names=[];const walk=p=>{for(const e of readdirSync(p,{withFileTypes:true})){if(e.isDirectory())walk(join(p,e.name));else names.push(e.name)}};walk(root);assert.ok(!names.includes('lease.db'))
   const after=await authority.request('/head',{});assert.equal(replica.replicaHead(local).hash,after.hash)
   const snapshot=join(root,'verified-snapshot');mkdirSync(snapshot);const db=new DatabaseSync(local,{readOnly:true});try{await backup(db,join(snapshot,'memory.db'))}finally{db.close()}
   for(const name of ['new-memories.json','persona-versions.json','ledger.jsonl'])copyFileSync(join(side,name),join(snapshot,name))
   const composite=createGenerationVerifier({ownedRoot:root,...spec})(snapshot);assert.deepEqual(composite,await authority.request('/state/head',{}))
   console.log(JSON.stringify({passed:true,realController:true,realOriginalMemoryPlugin:true,realOriginalSidecarTools:true,fourStoreCompositeMatches:true,compositeDigest:composite.digest,personaEditReplayed:false,personaReadOnReplay:personaAlreadyPresent,sidecarCommitAttempts:sidecarCommits,offlineModel:true,remoteAuthority:true,localAuthorityDatabaseCreated:false,remoteCommitAttempts:commits,headBefore:head.revision,headAfter:after.revision,term:grant.term,restoredPriorJournal:head.revision>0,originalsUnchanged:true,productionEnabled:false}))
  }finally{
   if(fiber){await fiber.dispose();if(fiber.inertia)await fiber.inertia}
   if(unmount)unmount()
   if(host)await host.cleanup()
   if(grant?.ok)await client.request('/admin',{command:'release',term:grant.term}).catch(()=>{})
   cleanup()
  }
  break
 }
}
