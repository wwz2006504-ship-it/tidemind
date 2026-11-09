// Profile-level adapter. All QQ/lease/retrieval business entrypoints remain the existing ones.
import {readFileSync,realpathSync} from 'node:fs'
import {resolve,join,dirname,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {startExistingRuntime,verifyLegacyHandoff} from './start-existing-runtime.mjs'
import {verifyFreshBaseline} from './fresh-baseline.mjs'
import {assertChatCompatibility,packageChatPaths} from './chat-compatibility.mjs'
import {createAuthorityClient} from './authority-client.mjs'
export const name='tidemind-existing-profile'
export const inject=['loader','agentPresets','tools','systemPrompt','agents','sessions','sessionController','sessionPersistence','webServer','timer','workspaceRegistry','attachments','llm']
const PACKAGE=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'..'))
const sha=b=>createHash('sha256').update(b).digest('hex')
const read=p=>{try{return JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''))}catch{throw Error('private runtime metadata unreadable or invalid')}}
export function inspectPreparedEntry(root){
 root=realpathSync(root)
 const state=read(join(root,'install.json')),marker=read(join(root,'owner.json')),service=read(join(root,'runtime/service-config.json'))
 if(typeof marker.owner!=='string'||!marker.owner||state.owner!==marker.owner||service.owner!==marker.owner||!['installed-not-activated','profile-activated'].includes(state.mode))throw Error('owned local installation required')
 if(!/^[a-f0-9]{16}$/.test(state.release||'')||realpathSync(join(root,'releases',state.release))!==PACKAGE)throw Error('profile code is not the selected installed service release')
 const within=p=>{const f=realpathSync(p),r=relative(root,f);if(!r||r.startsWith('..')||isAbsolute(r))throw Error('runtime metadata path escapes installation');return f}
 const pointer=read(within(join(root,'runtime/profile-plan-current.json'))),id=pointer.planId
 if(!/^[a-f0-9]{20}$/.test(id||''))throw Error('invalid prepared plan identity')
 const plan=read(within(join(root,'runtime/profile-plans',id,'plan.json')))
 if(plan.state!=='approved'||plan.description.owner!==state.owner)throw Error('profile plan is not approved for activation')
 if(realpathSync(plan.description.candidateRoot)!==PACKAGE)throw Error('profile code differs from approved candidate')
 const manifestName=plan.description.candidateManifestName||'MANIFEST-SHA256.json'
 if(!['MANIFEST-SHA256.json','INSTALL-FILES-SHA256.json'].includes(manifestName))throw Error('invalid candidate manifest name')
 const manifestRaw=readFileSync(join(PACKAGE,manifestName))
 if(sha(manifestRaw)!==plan.description.candidateManifestSha256)throw Error('approved candidate manifest changed')
 const manifest=JSON.parse(manifestRaw)
 for(const [name,digest]of Object.entries(manifest)){
  const path=realpathSync(join(PACKAGE,name)),r=relative(PACKAGE,path)
  if(!r||r.startsWith('..')||isAbsolute(r)||sha(readFileSync(path))!==digest)throw Error('approved candidate code changed')
 }
 if(sha(readFileSync(plan.description.profile))!==plan.files['candidate-profile.yml'])throw Error('actual profile is not the approved candidate profile')
 const inputPath=within(join(root,'runtime/profile-runtime-inputs.json')),raw=readFileSync(inputPath)
 if(!/^[a-f0-9]{64}$/.test(plan.description.runtimeInputsSha256||'')||sha(raw)!==plan.description.runtimeInputsSha256)throw Error('prepared runtime inputs changed or missing')
 const spec=read(inputPath)
 const runtimeRoot=realpathSync(spec.paths.root)
 if(![root,within(join(root,'runtime'))].includes(runtimeRoot)||realpathSync(service.env.TIDEMIND_SANDBOX_ROOT)!==runtimeRoot)throw Error('runtime owner root differs from plan')
 const mode=service.env.TIDEMIND_PROFILE_AUTHORITY||'local'
 if(!['local','remote'].includes(mode)||(spec.authorityMode||'local')!==mode||mode==='remote'&&spec.authorityUrl!==service.env.TIDEMIND_AUTHORITY_URL)throw Error('authority mode or endpoint differs from approved runtime inputs')
 const holder=spec.authorityHolder||'local'
 if(!['local','cloud'].includes(holder)||(service.env.TIDEMIND_PROFILE_HOLDER||'local')!==holder||holder==='cloud'&&mode!=='remote')throw Error('authority holder differs from approved runtime inputs')
 const local=within(join(spec.paths.localDir,'memory.db')),leaseFile=mode==='local'?within(service.env.TIDEMIND_LEASE_DB):null
 if(local!==realpathSync(service.env.TIDEMIND_DB))throw Error('working memory path differs from owned service')
 if(service.env.TIDEMIND_ALLOW_LEGACY_SYNTHETIC!=='0'||service.env.TIDEMIND_REQUIRE_STORE_PROOF!=='1')throw Error('production store verification is not enabled')
 return {root:runtimeRoot,spec,service,leaseFile,mode,holder,planId:id}
}
export async function activatePreparedEntry(ctx,config,{externalOverrides}={}){
 const prepared=inspectPreparedEntry(config.root),before=new Map(),holder=prepared.holder
 await verifyLegacyHandoff(ctx,{aiMemory:!!prepared.spec.aiMemory})
 assertChatCompatibility(packageChatPaths(PACKAGE))
 const source=prepared.spec.paths.sourceDataRoot,freshness={local:join(prepared.spec.paths.localDir,'memory.db'),requireAi:!!prepared.spec.aiMemory,snapshotFiles:{hub:join(PACKAGE,'host/aurabot-upstream/src/chat/hub.js'),reply:join(PACKAGE,'host/aurabot-upstream/src/chat/reply.js'),identity:join(source,'personas',prepared.spec.selectedPersona+'.md'),jsonMemory:join(source,'memories.json'),config:join(source,'config.json'),sessions:join(source,'sessions.json'),...(prepared.spec.aiMemory?{aiMemory:prepared.spec.aiMemory.source}:{})}}
 verifyFreshBaseline(prepared.spec.freshBaseline,freshness)
 // Set only the two keys needed to import the existing lease module; never expose service tokens.
 for(const [key,value]of Object.entries({TIDEMIND_SANDBOX_ROOT:prepared.root,...(prepared.mode==='local'?{TIDEMIND_LEASE_DB:prepared.leaseFile}:{})})){before.set(key,process.env[key]);process.env[key]=value}
 let runtime,grant,stopping,timer,api,client,custodyTransferred=false,transferStop
 const close=()=>stopping??=(async()=>{
  clearInterval(timer);let failure
  try{await runtime?.close()}catch(error){failure=error}
  try{if(grant?.ok&&!custodyTransferred)await api.release(holder,grant.term)}finally{
   for(const [key,value]of before)if(value===undefined)delete process.env[key];else process.env[key]=value
  }
  if(failure)throw failure
 })()
 function stopForTransfer(op,acceptCustody=client&&(({term})=>client.request('/transfer/retain',{op,term}))){
  if(!runtime||stopping||transferStop||typeof acceptCustody!=='function')throw Error('active profile and explicit transfer controller required')
  const work=(async()=>{
   await runtime.transfer.drain(op)
   const before=await api.status()
   if(stopping||!before.valid||before.holder!==holder||before.term!==grant.term)throw Error('source lease changed before transfer stop')
   const receipt=await acceptCustody(Object.freeze({op,holder,term:grant.term}))
   const current=await api.status(),source=await runtime.sourceAdmission.status()
   if(stopping||!receipt?.ok||receipt.holder!==holder||receipt.term!==grant.term||!current.valid||current.holder!==holder||current.term!==grant.term||current.expires_at!==receipt.expiresAt||current.expires_at<=before.expires_at||source.state!=='paused'||source.op!==op||source.pending||source.uncertain||source.expired||source.clientActive||source.clientFailures||source.durableActive)throw Error('controller renewal or source pause not confirmed')
   custodyTransferred=true
   await close()
   return {op,holder,term:grant.term,leaseRetained:true,profileClosed:true,wholeRuntimeQuiet:false}
  })()
  transferStop=work
  work.catch(()=>{if(!custodyTransferred)transferStop=undefined})
  return work
 }
 try{
  let gateway
  if(prepared.mode==='remote'){
   client=createAuthorityClient({url:prepared.spec.authorityUrl,token:prepared.service.env[holder==='cloud'?'TIDEMIND_CLOUD_TOKEN':'TIDEMIND_LOCAL_TOKEN']})
   api={status:()=>client.request('/admin',{command:'status'}),acquire:(_h,options)=>client.request('/admin',{command:'acquire',ttl:options.ttl}),renew:(_h,term)=>client.request('/admin',{command:'renew',term}),release:(_h,term)=>client.request('/admin',{command:'release',term})}
  }else{
   const lease=await import('../TideMind/deploy/existing/lease.mjs'),file=prepared.leaseFile;gateway=await import('../TideMind/deploy/existing/tide-gateway.mjs')
   api={openAuthority:()=>lease.openAuthority(file),status:()=>lease.status(file),acquire:(h,o={})=>lease.acquire(h,{...o,file}),renew:(h,t,o={})=>lease.renew(h,t,{...o,file}),release:(h,t)=>lease.release(h,t,{file}),fenced:(h,t,fn,o={})=>lease.fenced(h,t,fn,{...o,file})}
  }
  // Existing valid holder must never be adopted by reading its term from disk.
  grant=await api.acquire(holder,{ttl:60000});if(!grant.ok)throw Error('existing lease is held; profile activation refused')
  timer=setInterval(async()=>{try{if(!(await api.renew(holder,grant.term,{ttl:60000})).ok)close().catch(()=>{})}catch{close().catch(()=>{})}},20000);timer.unref()
  const heartbeat=prepared.spec.heartbeatConfig
  if(!heartbeat||typeof heartbeat.prompt!=='string')throw Error('prepared original heartbeat configuration required')
  verifyFreshBaseline(prepared.spec.freshBaseline,freshness)
  const authority=client?{mode:'remote',request:client.request,holder,term:grant.term}:{lease:api,gateway,holder,term:grant.term}
  runtime=await startExistingRuntime(ctx,{...prepared.spec,authority,remoteHistoryKey:client?prepared.service.env[holder==='cloud'?'TIDEMIND_CLOUD_MATERIALIZER_KEY':'TIDEMIND_LOCAL_MATERIALIZER_KEY']:undefined,signingKey:prepared.service.env.TIDEMIND_STORE_SIGNING_KEY,heartbeat:{readConfig:()=>heartbeat},externalOverrides:externalOverrides||{}})
  clearInterval(timer);timer=undefined
  return {runtime,close,stopForTransfer,planId:prepared.planId}
 }catch(error){try{await close()}catch(cleanupError){throw new AggregateError([error,cleanupError],'profile activation failed during cleanup')}throw error}
}
export async function apply(ctx,config){
 const handle=await activatePreparedEntry(ctx,config)
 try{
  ctx.effect(()=>()=>handle.close(),'tidemind: release existing profile runtime')
  ctx.provide('tidemindRuntime',handle.runtime)
 }catch(error){await handle.close();throw error}
}
