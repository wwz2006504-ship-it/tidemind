// SAME runtime/bootstrap with remote authority, synthetic four stores and offline I/O.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {runtimeBootstrapFixture} from './runtime-bootstrap-fixture.mjs'
import {authorityHttpFixture,keys} from './authority-http-fixture.mjs'
import {deriveCloudConfig} from './cloud-host-policy.mjs'
import {nativeDependencies} from './native-dependencies.mjs'
const sha=b=>createHash('sha256').update(b).digest('hex')
export async function remoteRuntimeFixture({cloud=false}={}){
 const f=await runtimeBootstrapFixture();let network,runtime,startupError;const sent=[]
 try{
  const directory=join(f.root,'private-ai');mkdirSync(directory)
  const source=join(f.paths.sourceDataRoot,'ai-original.jsonl'),raw=Buffer.from(JSON.stringify({seq:1,at:1,type:'node.created',data:{id:'original-ai',kind:'insight',text:'SYNTHETIC ORIGINAL AI'}})+'\n');writeFileSync(source,raw)
  f.spec.aiMemory={source,directory,baselineSha256:sha(raw),config:{injectIndex:true,maxIndexEntries:40,maxGraphNodes:500}}
  await f.loader.root.update([{id:'dsh-memory-layers',name:'dsh-memory-layers',disabled:true},{id:'dsh-heartbeat',name:'dsh-plugin-heartbeat',disabled:true},{id:'dsh-ai-memory',name:'dsh-ai-memory',disabled:true}]);await f.loader.await()
  network=await authorityHttpFixture({storageFixture:f,stateSpec:{sourceDataRoot:f.paths.sourceDataRoot,sqlBaselineFile:f.local,selectedPersona:'synthetic',pins:f.spec.pins,aiSource:source,aiBaselineSha256:sha(raw)},taskConfig:{execution:'remote-client',budget:20},qqConfig:{selfId:10001,allowTargets:['private:20001','group:30001'],mediaProtocol:'immutable-upload-v1',transport:async(action,params)=>{if(action.startsWith('send_'))sent.push({action,params});return action==='get_login_info'?{user_id:10001}:action==='get_group_member_info'?{role:'owner'}:{message_id:98000+sent.length}}}})
  let term=f.term
  if(cloud){
   const head=await network.local.request('/state/head',{}),s=head.sqlite,ack={revision:s.revision,hash:s.hash,data_hash:s.dataHash,baseline_hash:s.baseline,protected_hash:s.protectedHash,composite:head}
   f.lease.release('local',term);term=f.lease.acquire('cloud',{ttl:60000}).term;f.gateway.takeover(f.lease,'cloud',term,{expectedRevision:s.revision,expectedHash:s.hash,targetAck:ack,expectedComposite:head})
   const configFile=join(f.paths.dataRoot,'config.json'),config=JSON.parse(readFileSync(configFile))
   writeFileSync(configFile,JSON.stringify(deriveCloudConfig(config,nativeDependencies().BUILTINS.map(m=>m.id))))
   f.spec.cloudPolicy='chat-memory-only-v1';f.spec.externalOverrides={createOneBotClient:f.spec.externalOverrides.createOneBotClient}
  }
  f.spec.authority={mode:'remote',holder:cloud?'cloud':'local',term,request:(cloud?network.cloud:network.local).request};f.spec.remoteHistoryKey=cloud?keys.cloud:keys.local
  return {...f,term,network,remoteSent:sent,start:async()=>{try{return runtime=await f.start()}catch(error){startupError=error;throw error}},async cleanup(){const errors=[];for(const fn of [()=>runtime?.close(),()=>network.cleanup(),()=>f.cleanup()])try{await fn()}catch(error){errors.push(error)}if(errors.length)throw new AggregateError([...(startupError?[startupError]:[]),...errors],'remote fixture startup/cleanup failed')}}
 }catch(error){if(network)await network.cleanup();await f.cleanup();throw error}
}
