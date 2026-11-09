import {createSourceAdmission} from './source-admission.mjs'
import {bindCloudCosyVoice} from './cosyvoice-bridge.mjs'
import {createRuntimeTransferDrain} from './runtime-transfer-drain.mjs'
import {assertMemoryWritesOpen,createMemoryBarrier} from './memory-barrier.mjs'
import {createProtectedAiMemory} from './protected-ai-memory.mjs'
import * as aiMemoryPlugin from '../host/ai-memory/src/index.js'
// Assemble existing components in the actual DSH context. This library does not edit profiles.
import {readFileSync,realpathSync} from 'node:fs'
import {join,relative,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createCompositeHead} from './composite-head.mjs'
import {createIdentityBinding} from './identity-binding.mjs'
import {createPersonaVersions} from './persona-versions.mjs'
import {createProtectedJsonMemory} from './protected-json-memory.mjs'
import {createSessionBindings} from './session-bindings.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import {createCognitiveDriver} from './cognitive-driver.mjs'
import {createNativeHostBindings} from './native-host-bindings.mjs'
import {prepareRemoteRuntime} from './prepare-remote-runtime.mjs'
import {wrapRemoteOperationTool} from './remote-operation-scope.mjs'
import {assertCloudConfig,bindCloudToolGuard} from './cloud-host-policy.mjs'
import {mountExistingHost} from './mount-existing-host.mjs'
import * as fenced from './fenced-store.mjs'
import * as memory from '../host/plugin/src/index.js'
import * as replica from '../TideMind/deploy/existing/tide-replica.mjs'
let owner
const digest=b=>createHash('sha256').update(b).digest('hex')
const json=p=>{try{return JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''))}catch{throw Error('private profile JSON unavailable or invalid')}}
export async function verifyLegacyHandoff(ctx,{aiMemory=false}={}){
 const loader=ctx.get('loader')
 if(typeof loader?.entries!=='function')throw Error('actual profile loader required to verify handoff')
 const entries=[...loader.entries()]
 for(const id of ['dsh-memory-layers','dsh-heartbeat',...(aiMemory?['dsh-ai-memory']:[])]){
  const rows=entries.filter(e=>e.options.id===id||e.options.name===(id==='dsh-heartbeat'?'dsh-plugin-heartbeat':id))
  if(!rows.length)throw Error('legacy entry missing from reviewed topology: '+id)
  for(const entry of rows){
   if(!entry.disabled)throw Error('legacy entry still enabled: '+id)
   if(entry.fiber){await entry.fiber.await();if(entry.fiber.uid!==null)throw Error('legacy entry still mounted: '+id)}
  }
 }
 if(ctx.get('aurabot')||ctx.tools.get('lmem_write'))throw Error('legacy host or memory tools still active')
}
export async function startExistingRuntime(ctx,spec){
 if(owner)throw Error('another profile runtime already owns this process')
 const token={};owner=token
 let mounted,binding,memoryFiber,aiFiber,supervisor,timer,closing,closed=false,driver,remoteRuntime,cloudGuard
 const previous=new Map(),assigned=new Map()
 const setEnv=(k,v)=>{previous.set(k,process.env[k]);process.env[k]=String(v);assigned.set(k,String(v))}
 const close=()=>closing??=(async()=>{
  clearInterval(timer);const failures=[]
  for(const fn of [()=>mounted?.dispose(),()=>supervisor?.close(),()=>driver?.dispose(),()=>fenced.drain(),()=>remoteRuntime?.sidecars.idle(),async()=>{if(memoryFiber){await memoryFiber.dispose();if(memoryFiber.inertia)await memoryFiber.inertia}},async()=>{if(aiFiber){await aiFiber.dispose();if(aiFiber.inertia)await aiFiber.inertia}},()=>binding?.dispose(),()=>cloudGuard?.()])try{await fn()}catch(error){failures.push(error)}
  for(const [k,value]of assigned)if(process.env[k]===value){if(previous.get(k)===undefined)delete process.env[k];else process.env[k]=previous.get(k)}
  closed=true;if(owner===token)owner=undefined
  if(failures.length)throw new AggregateError(failures,'profile cleanup completed with errors')
 })()
 try{
  await verifyLegacyHandoff(ctx,{aiMemory:!!spec?.aiMemory})
  const {paths,authority,pins}=spec||{}
  const remote=authority?.mode==='remote',holder=authority?.holder,cloud=holder==='cloud'
  if(!['local','cloud'].includes(holder)||cloud&&!remote||!Number.isSafeInteger(authority.term)||(remote?typeof authority.request!=='function'||authority.lease:typeof authority.lease?.fenced!=='function'||typeof authority.lease?.renew!=='function')||!pins)throw Error('owned existing authority and reviewed source pins required')
  const root=realpathSync(paths.root),source=realpathSync(paths.sourceDataRoot)
  const checked=p=>{const value=realpathSync(p),r=relative(root,value);if(!r||r.startsWith('..')||isAbsolute(r))throw Error('runtime path outside owned root');return value}
  const dataRoot=checked(paths.dataRoot),localDir=checked(paths.localDir),home=checked(paths.home),workspace=checked(paths.workspace),notes=checked(paths.notes)
  if(dataRoot===source)throw Error('original data root cannot be the writable profile root')
  const originalConfig=readFileSync(join(source,'config.json'))
  if(digest(originalConfig)!==pins.config)throw Error('original configuration changed since preparation')
  const config=json(join(dataRoot,'config.json'))
  if(cloud){if(spec.cloudPolicy!=='chat-memory-only-v1')throw Error('reviewed cloud capability policy required');assertCloudConfig(config);cloudGuard=bindCloudToolGuard(ctx)}
  if(config.persona?.current!==spec.selectedPersona)throw Error('selected original persona differs from prepared profile')
  if(typeof spec.signingKey!=='string'||spec.signingKey.length<32||!spec.memoryConfig||typeof spec.heartbeat?.readConfig!=='function')throw Error('explicit private signing key, original memory settings and heartbeat source required')
  setEnv('TIDEMIND_SANDBOX_ROOT',root);setEnv('TIDEMIND_AURABOT_DATA_ROOT',dataRoot);setEnv('TIDEMIND_AURABOT_HOME',home);setEnv('TIDEMIND_AURABOT_WORKSPACE',workspace);setEnv('TIDEMIND_SELF_NOTES_DIR',notes);setEnv('TIDEMIND_AURABOT_MEMORY_DB',join(localDir,'memory.db'));setEnv('TIDEMIND_STORE_SIGNING_KEY',spec.signingKey);setEnv('TIDEMIND_REQUIRE_STORE_PROOF','1');setEnv('TIDEMIND_REQUIRE_QQ_BINDING','1');setEnv('TIDEMIND_ALLOW_LEGACY_SYNTHETIC','0');setEnv('TIDEMIND_REQUIRE_COMPOSITE_HANDOVER','1');setEnv('TIDEMIND_REQUIRE_HANDOVER_TICKET','1');setEnv('TIDEMIND_REQUIRE_MEMORY_BARRIER','1');setEnv('TIDEMIND_REQUIRE_SOURCE_GATE','1')
  if(!remote)authority.lease.fenced('local',authority.term,db=>assertMemoryWritesOpen(db))
  const local=join(localDir,'memory.db'),historyReader=createSessionHistoryReader(ctx.get('sessionPersistence'))
  if(remote){remoteRuntime=await prepareRemoteRuntime({spec,root,dataRoot,local,historyReader,botQQ:config.botQQ});supervisor=remoteRuntime.supervisor}
  const head=remote?await authority.request('/head',{}):authority.gateway.head(authority.lease),current=replica.replicaHead(local)
  if(head.home!==holder||head.revision!==current.revision||head.hash!==current.hash||head.baseline_hash!==current.baseline_hash||head.protected_hash!==current.protected_hash)throw Error('working memory replica does not match authority')
  const registry=createSessionBindings({readMappings:()=>json(join(dataRoot,'sessions.json')),ownerQQ:config.ownerQQ,resolveRegisteredAgent:id=>ctx.agents.get(id)})
  const mappings=json(join(dataRoot,'sessions.json')),sessionId=mappings.chats[registry.ownerChatId]?.sessionId
  if(!sessionId)throw Error('existing owner session required; no replacement session is created')
  const controller=ctx.get('sessionController'),resolved=await controller.resolveAgent(sessionId)
  if(resolved.error)throw resolved.error
  const activityAgent=resolved.agent;registry.authorize(activityAgent,registry.ownerChatId)
  const resolveActivityAgent=async()=>{const current=await controller.resolveAgent(registry.ownerSessionId());if(current.error)throw current.error;registry.authorize(current.agent,registry.ownerChatId);return current.agent}
  const sourceAdmission=remoteRuntime?.sourceAdmission||createSourceAdmission({lease:authority.lease,holder:'local',term:authority.term}),sourceState=await sourceAdmission.status();if(sourceState.state!=='open')throw Error('paused source admission requires recovery before startup');if(sourceState.durableActive!==0)throw Error('in-flight source admission requires recovery before startup')
  const identity=remoteRuntime?.identity||createPersonaVersions({identity:createIdentityBinding({directory:join(source,'personas'),selected:spec.selectedPersona,expectedSha256:pins.persona}),ownedRoot:root,stateFile:join(dataRoot,'persona-versions.json'),withWriteGuard:fn=>authority.lease.fenced('local',authority.term,db=>{assertMemoryWritesOpen(db);return fn()})})
  const protectedMemory=remoteRuntime?.protectedMemory||createProtectedJsonMemory({source:join(source,'memories.json'),expectedSha256:pins.jsonMemory,ownedRoot:root,overlay:join(dataRoot,'new-memories.json'),withWriteGuard:fn=>authority.lease.fenced('local',authority.term,db=>{assertMemoryWritesOpen(db);return fn()})})
  const aiMemory=remoteRuntime?.aiMemory||(spec.aiMemory?createProtectedAiMemory({source:spec.aiMemory.source,baselineSha256:spec.aiMemory.baselineSha256,ownedRoot:root,directory:checked(spec.aiMemory.directory),withWriteGuard:fn=>authority.lease.fenced('local',authority.term,db=>{assertMemoryWritesOpen(db);if(db.prepare('SELECT home FROM tide_head').get().home!=='local')throw Error('standby AI memory is read-only');return fn()})}):undefined)
  driver=await createCognitiveDriver({ctx,controller,sessionId:'tidemind-cognitive-'+config.ownerQQ,cwd:workspace,maxTokens:spec.maxTokens??128,agentPreset:spec.cognitivePreset||'aurabot-private',modelHelp:spec.modelHelp})
  fenced.configure({...authority,...(remote?{remoteStoreExecutor:remoteRuntime.store}:{}),root,localDir,local,bindings:registry.bindings,runMaintenance:async(reason,fn)=>{if(!supervisor)return {skipped:'starting'};const result=await supervisor.runActivity({id:'memory:'+randomUUID(),input:'memory maintenance '+reason,units:1},fn);return result.state==='done'?result.value:result}})
  if(!remote)supervisor=createTaskCheckpoints({...authority,budget:spec.budget??20,handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,driver.handle]))})
  memoryFiber=ctx.plugin({name:'tidemind-existing-memory',inject:memory.inject,apply(child){memory.apply(child,{...spec.memoryConfig,dir:localDir,enabled:true,logRetrieval:false})}})
  await memoryFiber.await();await fenced.drain()
  if(aiMemory){aiFiber=ctx.plugin({name:'tidemind-existing-ai-memory',inject:aiMemoryPlugin.inject,apply(child){aiMemoryPlugin.apply(child,{...spec.aiMemory.config,dir:aiMemory.lib.dir,enabled:true},aiMemory.lib,remote?aiMemory.operations:undefined,remote?wrapRemoteOperationTool:undefined)}});await aiFiber.await()}
  binding=createNativeHostBindings({authority:remoteRuntime?.authority||authority,...(remote?{createCapabilities:remoteRuntime.createCapabilities}:{}),identity,protectedMemory,taskSupervisor:supervisor,activityAgent,resolveActivityAgent,sourceAdmission,sessionBindings:registry,allowTargets:[...new Set([registry.ownerChatId,...(config.allow?.private||[]).map(id=>'private:'+id),...(config.allow?.groups||[]).map(id=>'group:'+id)])],historyReader,heartbeat:{...spec.heartbeat,legacyDetached:true},externalOverrides:spec.externalOverrides||{}})
  if(cloud&&spec.cloudCosyVoice)binding.bindings.cloudVoice=bindCloudCosyVoice({...spec.cloudCosyVoice,root:dataRoot})
  mounted=await mountExistingHost(ctx,{bindings:binding.bindings,requiredModules:spec.requiredModules})
  for(const agent of [activityAgent,driver.agent]){
   const assembly=await ctx.systemPrompt.assemble({scope:agent,agent}),prefix=assembly.sections.find(s=>s.name==='deployment:persona-prefix')
   if(!prefix?.text.includes('{{aurabot_persona}}')||!prefix.text.includes('{{aurabot_rules_private}}'))throw Error('original private preset persona prefix is not mounted')
  }
  timer=setInterval(async()=>{try{const r=remote?await authority.request('/admin',{command:'renew',term:authority.term}):authority.lease.renew('local',authority.term,{ttl:60000});if(!r.ok)close().catch(()=>{})}catch{close().catch(()=>{})}},20000);timer.unref()
  if(remote)await supervisor.startPhaseWorker(driver)
  const memoryBarrier=remoteRuntime?.memoryBarrier||createMemoryBarrier({lease:authority.lease,holder:'local',term:authority.term})
  const compositeHead=remoteRuntime?.compositeHead||(()=>authority.lease.fenced('local',authority.term,()=>createCompositeHead({sqlite:replica.replicaHead(local),jsonMemory:protectedMemory.inspect(),persona:identity.inspect(),aiMemory:aiMemory?.inspect()})))
  const transfer=createRuntimeTransferDrain({ctx,authority,registry,driver,host:mounted.handle,supervisor,sourceAdmission,memoryBarrier,compositeHead,drainMemory:()=>fenced.drain()})
  const status=()=>closed?{closed:true}:remote?(async()=>({closed:false,revision:(await authority.request('/head',{})).revision,personaVersion:identity.inspect().overlayVersion,tasks:await supervisor.status(),sessions:registry.inspect()}))():{closed:false,revision:authority.gateway.head(authority.lease).revision,personaVersion:identity.inspect().overlayVersion,tasks:supervisor.status(),sessions:registry.inspect()}
  return Object.freeze({host:mounted.handle,driver,identity,protectedMemory,aiMemory,supervisor,registry,close,sourceAdmission,memoryBarrier,compositeHead,transfer,status})
 }catch(error){try{await close()}catch(cleanupError){throw new AggregateError([error,cleanupError],'profile startup failed and cleanup reported errors')}throw error}
}
