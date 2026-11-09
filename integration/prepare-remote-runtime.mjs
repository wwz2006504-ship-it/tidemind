// Components for the SAME startExistingRuntime entry. No lease emulation or
// second host startup. Original SQL/JSON/persona/AI adapters own all mutations.
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {MemoryStore} from '../host/plugin/src/store.js'
import {checkedPath,replicaHead} from '../TideMind/deploy/existing/tide-replica.mjs'
import {createCompositeHead} from './composite-head.mjs'
import {createRemoteActivitySupervisor} from './remote-activity-supervisor.mjs'
import {createRemoteStoreExecutor} from './remote-store-executor.mjs'
import {createRemoteSidecars} from './remote-sidecars.mjs'
import {createRemoteSourceAdmission} from './remote-source-admission.mjs'
import {prepareRemoteHostCapabilities} from './remote-host-capabilities.mjs'
import {remoteOperationId} from './remote-operation-scope.mjs'
export async function prepareRemoteRuntime({spec,root,dataRoot,local,historyReader,botQQ}){
 const authority=spec.authority
 const holder=authority?.holder
 if(authority?.mode!=='remote'||!['local','cloud'].includes(holder)||typeof authority.request!=='function'||authority.lease||!spec.aiMemory)throw Error('explicit remote authority and all four original stores required')
 const request=(path,body={})=>authority.request(path,{...body,term:authority.term})
 const protocol=await request('/task/protocol')
 if(protocol.protocol!=='original-task-client-v1'||protocol.phases!==true||protocol.toolPolicy!=='existing')throw Error('reviewed original remote phase executor unavailable')
 const barrier=await request('/transfer/status')
 if(barrier.state!=='open')throw Error('paused memory barrier requires recovery before startup')
 const supervisor=createRemoteActivitySupervisor({authority,term:authority.term}),client=supervisor.authority
 try{
  const directory=join(dataRoot,'remote-sidecars'),journal=join(dataRoot,'remote-pending'),mediaRoot=join(dataRoot,'remote-media')
  for(const path of [directory,journal,mediaRoot]){checkedPath(path);mkdirSync(path,{recursive:true,mode:0o700});checkedPath(path)}
  const sidecars=createRemoteSidecars({authority:client,holder,term:authority.term,ownedRoot:root,directory,journalDirectory:journal,spec:{sourceDataRoot:spec.paths.sourceDataRoot,selectedPersona:spec.selectedPersona,pins:spec.pins,aiSource:spec.aiMemory.source,aiBaselineSha256:spec.aiMemory.baselineSha256},getOperationId:remoteOperationId})
  const recovered=await sidecars.recover();if(!recovered.resolved)throw Error('pending sidecar requires recovery')
  await sidecars.initialize()
  const store=createRemoteStoreExecutor({authority:client,holder,term:authority.term,local,journalDirectory:journal,MemoryStore})
  const sql=await store.recover();if(sql.pending&&!sql.resolved&&!sql.committed)throw Error('pending SQL operation requires recovery')
  const sourceAdmission=createRemoteSourceAdmission({authority:client,term:authority.term})
  const createCapabilities=await prepareRemoteHostCapabilities({authority:client,holder,term:authority.term,selfId:botQQ,historyReader,historyKey:spec.remoteHistoryKey,mediaRoot,sourceAdmission})
  const compositeHead=async()=>{await store.idle();await sidecars.idle();const localHead=createCompositeHead({sqlite:replicaHead(local),jsonMemory:sidecars.json.inspect(),persona:sidecars.persona.inspect(),aiMemory:sidecars.aiMemory.inspect()}),canonical=await request('/state/head');if(localHead.digest!==canonical.digest)throw Error('local four-store state differs from remote authority');return localHead}
  return {supervisor,store,sidecars,sourceAdmission,createCapabilities,identity:sidecars.persona,protectedMemory:sidecars.json,aiMemory:sidecars.aiMemory,compositeHead,authority:{...authority,request:client.request},memoryBarrier:{mode:'remote',status:()=>request('/transfer/status'),begin:op=>request('/transfer/freeze',{op}),seal:async(op,readHead)=>request('/transfer/seal',{op,head:await readHead()}),resume:op=>request('/transfer/resume',{op})}}
 }catch(error){await supervisor.close().catch(()=>{});throw error}
}
