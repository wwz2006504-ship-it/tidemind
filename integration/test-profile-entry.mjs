import test from 'node:test'
import assert from 'node:assert/strict'
import {cpSync,mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs'
import {join,relative,resolve} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {runtimeBootstrapFixture} from './runtime-bootstrap-fixture.mjs'
import {remoteRuntimeFixture} from './remote-runtime-fixture.mjs'
import {authorityHttpFixture,keys,tokens} from './authority-http-fixture.mjs'
import {captureFreshBaseline} from './fresh-baseline.mjs'
import {freezeStoppedSessionHistory} from './session-history-freeze.mjs'
import {DatabaseSync} from 'node:sqlite'
import {spawnSync} from 'node:child_process'
import {createSessionHistoryAuthority,signHistoryFrontier} from './session-history-authority.mjs'
const PACKAGE=fileURLToPath(new URL('../',import.meta.url)),sha=b=>createHash('sha256').update(b).digest('hex')
async function fixture({remote=false,cloud=false}={}){
 const f=remote?await remoteRuntimeFixture({cloud}):await runtimeBootstrapFixture();let entry
 try{
  const release='c'.repeat(16),candidate=join(f.root,'releases',release),runtime=join(f.root,'runtime'),id='d'.repeat(20),planRoot=join(runtime,'profile-plans',id)
  mkdirSync(candidate,{recursive:true});mkdirSync(planRoot,{recursive:true})
  for(const name of ['integration','host','TideMind'])cpSync(join(PACKAGE,name),join(candidate,name),{recursive:true,filter:p=>!p.includes('__pycache__')&&!p.endsWith('.pyc')})
  const manifest={};function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const p=join(dir,item.name);if(item.isDirectory())walk(p);else manifest[relative(candidate,p).replaceAll('\\','/')]=sha(readFileSync(p))}}walk(candidate)
  const manifestBytes=Buffer.from(JSON.stringify(manifest));writeFileSync(join(candidate,'INSTALL-FILES-SHA256.json'),manifestBytes)
  const owner='SYNTHETIC INSTALL OWNER',profile=join(f.root,'cordis.patch.yml'),profileBytes=Buffer.from('# SYNTHETIC APPROVED PROFILE\n')
  writeFileSync(profile,profileBytes);writeFileSync(join(f.root,'owner.json'),JSON.stringify({owner}));writeFileSync(join(f.root,'install.json'),JSON.stringify({owner,release,mode:'installed-not-activated'}))
  writeFileSync(join(runtime,'service-config.json'),JSON.stringify({owner,env:{TIDEMIND_SANDBOX_ROOT:f.root,TIDEMIND_LEASE_DB:join(f.root,'lease.db'),TIDEMIND_DB:f.local,TIDEMIND_STORE_SIGNING_KEY:f.spec.signingKey,TIDEMIND_ALLOW_LEGACY_SYNTHETIC:'0',TIDEMIND_REQUIRE_STORE_PROOF:'1',TIDEMIND_REQUIRE_QQ_BINDING:'1'}}))
  writeFileSync(join(f.paths.sourceDataRoot,'sessions.json'),readFileSync(join(f.paths.dataRoot,'sessions.json')))
  if(remote){const file=join(runtime,'service-config.json'),service=JSON.parse(readFileSync(file));Object.assign(service.env,{TIDEMIND_PROFILE_AUTHORITY:'remote',TIDEMIND_PROFILE_HOLDER:cloud?'cloud':'local',TIDEMIND_AUTHORITY_URL:f.network.url,[cloud?'TIDEMIND_CLOUD_TOKEN':'TIDEMIND_LOCAL_TOKEN']:cloud?tokens.cloud:tokens.local,[cloud?'TIDEMIND_CLOUD_MATERIALIZER_KEY':'TIDEMIND_LOCAL_MATERIALIZER_KEY']:cloud?keys.cloud:keys.local});writeFileSync(file,JSON.stringify(service))}
  const freshBaseline=captureFreshBaseline({sourceFile:f.cloud,requiredCoreIds:[f.core.id],files:{hub:join(candidate,'host/aurabot-upstream/src/chat/hub.js'),reply:join(candidate,'host/aurabot-upstream/src/chat/reply.js'),identity:join(f.paths.sourceDataRoot,'personas/synthetic.md'),jsonMemory:join(f.paths.sourceDataRoot,'memories.json'),config:join(f.paths.sourceDataRoot,'config.json'),sessions:join(f.paths.dataRoot,'sessions.json'),...(remote?{aiMemory:f.spec.aiMemory.source}:{})}})
  const inputs={paths:f.paths,pins:f.spec.pins,freshBaseline,selectedPersona:f.spec.selectedPersona,memoryConfig:f.spec.memoryConfig,budget:20,heartbeatConfig:f.spec.heartbeat.readConfig(),...(remote?{authorityMode:'remote',authorityHolder:cloud?'cloud':'local',authorityUrl:f.network.url,aiMemory:f.spec.aiMemory,...(cloud?{cloudPolicy:'chat-memory-only-v1'}:{})}:{})},inputBytes=Buffer.from(JSON.stringify(inputs))
  writeFileSync(join(runtime,'profile-runtime-inputs.json'),inputBytes)
  const plan={state:'approved',description:{owner,candidateRoot:candidate,candidateManifestName:'INSTALL-FILES-SHA256.json',candidateManifestSha256:sha(manifestBytes),profile,runtimeInputsSha256:sha(inputBytes)},files:{'candidate-profile.yml':sha(profileBytes)}}
  const planFile=join(planRoot,'plan.json');writeFileSync(planFile,JSON.stringify(plan));writeFileSync(join(runtime,'profile-plan-current.json'),JSON.stringify({planId:id}))
  entry=await import(pathToFileURL(join(candidate,'integration/profile-entry.mjs')).href)
  return {...f,candidate,runtime,plan,planFile,profile,entry,cleanup:f.cleanup}
 }catch(error){await f.cleanup();throw error}
}
test('approved selected release acquires existing lease, starts actual original host and releases after full cleanup',async()=>{const f=await fixture();let handle;try{f.lease.release('local',f.term);const previous=f.lease.status().term;handle=await f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides});assert.equal(f.lease.status().term,previous+1);assert.equal(handle.runtime.status().tasks.control.rest,1);await f.emit(f.event(19101));for(let i=0;i<300&&(f.requests.length<1||f.agent.status!=='idle'||f.sent.length<1);i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.sent.length,1);assert.match(JSON.stringify(f.requests[0].messages),/SYNTHETIC BOOTSTRAP IDENTITY/);await handle.close();assert.equal(f.lease.status().holder,null);assert.equal(f.lease.status().term,previous+1);assert.equal(f.routes.size,0)}finally{await handle?.close();await f.cleanup()}})
test('profile accepts the sandbox layout created by the local installer',async()=>{
 const f=await fixture()
 try{
  const inputFile=join(f.runtime,'profile-runtime-inputs.json')
  const serviceFile=join(f.runtime,'service-config.json')
  const spec=JSON.parse(readFileSync(inputFile))
  const service=JSON.parse(readFileSync(serviceFile))
  const localDir=join(f.runtime,'memory')
  mkdirSync(localDir)
  spec.paths.root=f.runtime
  spec.paths.localDir=localDir
  service.env.TIDEMIND_SANDBOX_ROOT=f.runtime
  service.env.TIDEMIND_DB=join(localDir,'memory.db')
  service.env.TIDEMIND_LEASE_DB=join(f.runtime,'lease.db')
  writeFileSync(service.env.TIDEMIND_DB,'')
  writeFileSync(service.env.TIDEMIND_LEASE_DB,'')
  const inputBytes=Buffer.from(JSON.stringify(spec))
  writeFileSync(inputFile,inputBytes)
  writeFileSync(serviceFile,JSON.stringify(service))
  f.plan.description.runtimeInputsSha256=sha(inputBytes)
  writeFileSync(f.planFile,JSON.stringify(f.plan))
  assert.equal(f.entry.inspectPreparedEntry(f.root).root,f.runtime)
 }finally{await f.cleanup()}
})
test('prepared but unapproved profile cannot acquire or change the existing lease',async()=>{const f=await fixture();try{f.plan.state='prepared';writeFileSync(f.planFile,JSON.stringify(f.plan));const before=f.lease.status();await assert.rejects(f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides}),/not approved/);assert.equal(f.lease.status().term,before.term);assert.equal(f.routes.size,0)}finally{await f.cleanup()}})
test('another valid lease holder is never adopted or renewed by profile startup',async()=>{const f=await fixture();try{const before=f.lease.status();await assert.rejects(f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides}),/lease is held/);assert.equal(f.lease.status().term,before.term);assert.equal(f.lease.status().expires_at,before.expires_at);assert.equal(f.routes.size,0)}finally{await f.cleanup()}})
test('code, runtime input or actual profile drift blocks before acquiring a lease',async()=>{const f=await fixture();try{const input=join(f.runtime,'profile-runtime-inputs.json'),saved=readFileSync(input);writeFileSync(input,Buffer.concat([saved,Buffer.from(' ')]));assert.throws(()=>f.entry.inspectPreparedEntry(f.root),/inputs changed/);writeFileSync(input,saved);writeFileSync(f.profile,'CHANGED PROFILE');assert.throws(()=>f.entry.inspectPreparedEntry(f.root),/actual profile/);writeFileSync(f.profile,'# SYNTHETIC APPROVED PROFILE\n');writeFileSync(join(f.candidate,'integration/profile-entry.mjs'),'CHANGED CODE');assert.throws(()=>f.entry.inspectPreparedEntry(f.root),/candidate code changed/);assert.equal(f.routes.size,0)}finally{await f.cleanup()}})
test('a new core memory after preparation blocks activation before a lease is acquired',async()=>{const f=await fixture();try{
 f.lease.release('local',f.term);const before=f.lease.status()
 const db=new DatabaseSync(f.cloud);try{db.prepare('UPDATE memories SET content=? WHERE id=?').run('SYNTHETIC NEW CORE AFTER PREPARATION',f.core.id)}finally{db.close()}
 await assert.rejects(f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides}),/source baseline changed/)
 assert.equal(f.lease.status().term,before.term);assert.equal(f.lease.status().holder,null);assert.equal(f.routes.size,0)
}finally{await f.cleanup()}})
test('even a newly pinned candidate cannot silently change original reply filtering',async()=>{const f=await fixture();try{
 const file=join(f.candidate,'host/aurabot/src/chat/reply.js');writeFileSync(file,readFileSync(file,'utf8').replace('const MAX_BUBBLES = 5','const MAX_BUBBLES = 4'))
 const manifestFile=join(f.candidate,'INSTALL-FILES-SHA256.json'),manifest=JSON.parse(readFileSync(manifestFile));manifest['host/aurabot/src/chat/reply.js']=sha(readFileSync(file));const raw=Buffer.from(JSON.stringify(manifest));writeFileSync(manifestFile,raw)
 f.plan.description.candidateManifestSha256=sha(raw);writeFileSync(f.planFile,JSON.stringify(f.plan));f.lease.release('local',f.term);const before=f.lease.status()
 await assert.rejects(f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides}),/original reply algorithm changed/)
 assert.equal(f.lease.status().term,before.term);assert.equal(f.lease.status().holder,null);assert.equal(f.routes.size,0)
}finally{await f.cleanup()}})

test('same approved profile entry acquires remote original authority and releases only after original host cleanup',async()=>{
 const f=await fixture({remote:true});let handle
 try{
  f.lease.release('local',f.term);const previous=f.lease.status().term
  handle=await f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides})
  assert.equal(f.lease.status().term,previous+1);assert.equal((await handle.runtime.status()).tasks.control.rest,1)
  await f.emit(f.event(79101));for(let i=0;i<300&&(f.agent.status!=='idle'||f.remoteSent.length<1);i++)await new Promise(r=>setTimeout(r,5))
  assert.equal(f.remoteSent.length,1);assert.equal(f.sent.length,0)
  await handle.close();assert.equal(f.lease.status().holder,null);assert.equal(f.lease.status().term,previous+1);assert.equal(f.routes.size,0)
 }finally{await handle?.close();await f.cleanup()}
})

test('changing service authority endpoint without approving new runtime inputs refuses before lease acquisition',async()=>{
 const f=await fixture({remote:true});try{
  const file=join(f.runtime,'service-config.json'),service=JSON.parse(readFileSync(file));service.env.TIDEMIND_AUTHORITY_URL='http://127.0.0.1:1/';writeFileSync(file,JSON.stringify(service))
  const before=f.lease.status();assert.throws(()=>f.entry.inspectPreparedEntry(f.root),/endpoint differs/);assert.equal(f.lease.status().term,before.term)
 }finally{await f.cleanup()}
})

test('same approved profile entry mounts cloud holder with cloud-only credentials and no local module loading',async()=>{
 const f=await fixture({remote:true,cloud:true});let handle
 try{
  f.lease.release('cloud',f.term)
  const service=JSON.parse(readFileSync(join(f.runtime,'service-config.json')));assert.equal(service.env.TIDEMIND_LOCAL_TOKEN,undefined)
  handle=await f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides})
  assert.equal(f.lease.status().holder,'cloud');assert.equal(handle.runtime.host.getConfig().safeMode,true)
  await f.emit(f.event(79701));for(let i=0;i<300&&(f.agent.status!=='idle'||!f.remoteSent.length);i++)await new Promise(r=>setTimeout(r,5))
  assert.equal(f.remoteSent.length,1);assert.equal(f.sent.length,0)
  await handle.close();assert.equal(f.lease.status().holder,null)
 }finally{await handle?.close();await f.cleanup()}
})

test('explicit controller renews the original term before candidate profile cleanup retains custody',async()=>{
 const f=await fixture();let handle
 try{
  f.lease.release('local',f.term)
  handle=await f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides})
  const before=f.lease.status()
  await assert.rejects(handle.stopForTransfer('transfer-stop',async()=>({ok:true,holder:'local',term:before.term,expiresAt:before.expires_at})),/renewal or source pause/)
  const result=await handle.stopForTransfer('transfer-stop',async({holder,term})=>f.lease.renew(holder,term,{ttl:90000}))
  assert.equal(result.term,before.term);assert.equal(result.wholeRuntimeQuiet,false)
  await handle.close()
  assert.equal(f.lease.status().holder,'local');assert.equal(f.routes.size,0)
 }finally{await handle?.close();const status=f.lease.status();if(status.holder==='local')f.lease.release('local',status.term);await f.cleanup()}
})

test('remote controller retains term through profile stop and native session freeze',async()=>{
 const f=await fixture({remote:true});let handle,frozen,restarted
 try{
  f.lease.release('local',f.term)
  handle=await f.entry.activatePreparedEntry(f.ctx,{root:f.root},{externalOverrides:f.spec.externalOverrides})
  const term=f.lease.status().term
  const head=await handle.runtime.compositeHead()
  await assert.rejects(f.network.local.request('/transfer/retain',{op:'remote-profile-stop',term}),/HTTP 409/)
  const mappings=JSON.parse(readFileSync(join(f.paths.dataRoot,'sessions.json'))).chats
  mappings['system:cognitive']={sessionId:handle.runtime.driver.agent.id,preset:'aurabot-private',level:'full'}
  frozen=await freezeStoppedSessionHistory({ctx:f.ctx,mappings,historyRoot:join(f.root,'sessions'),stopRuntime:async()=>{
   await handle.stopForTransfer('remote-profile-stop')
   await f.closeRuntime()
   const module=JSON.stringify(new URL('./native-session-storage.mjs',import.meta.url).href)
   const script=`import {openNativeSessionStorage} from ${module};const b=await openNativeSessionStorage(process.argv[1]);const w=await b.persistence.open(process.argv[2],'write');await w.close();await b.close()`
   const exited=spawnSync(process.execPath,['--input-type=module','-e',script,join(f.root,'sessions'),f.agent.id],{windowsHide:true,encoding:'utf8',timeout:15000})
   assert.equal(exited.status,0,exited.stderr||exited.error?.message)
  }})
  assert.equal(f.lease.status().term,term);assert.equal(f.lease.status().holder,'local')
  const retained=await f.network.local.request('/transfer/retain',{op:'remote-profile-stop',term})
  assert.equal(retained.replayed,true)
  const limit=performance.now()+18000
  while(f.lease.status().expires_at<=retained.expiresAt&&performance.now()<limit)await new Promise(resolve=>setTimeout(resolve,100))
  const renewed=f.lease.status()
  assert.equal(renewed.term,term);assert.ok(renewed.expires_at>retained.expiresAt)
  assert.ok(renewed.expires_at<=retained.deadline)
  assert.equal((await frozen.snapshot()).digest,frozen.bundle.digest)
  const op='remote-profile-stop',s=head.sqlite
  const ack={revision:s.revision,hash:s.hash,data_hash:s.dataHash,baseline_hash:s.baseline,protected_hash:s.protectedHash,composite:head}
  const history=createSessionHistoryAuthority({lease:f.lease,keys,initialDigest:frozen.bundle.digest,currentFourHead:()=>head})
  const signed=signHistoryFrontier({op,holder:'local',term,expectedRevision:0,expectedDigest:null,bundleDigest:frozen.bundle.digest,fourDigest:head.digest},keys.local)
  await f.network.local.request('/transfer/freeze',{op,term})
  assert.equal(history.publish('local',term,{signed,bundle:await frozen.snapshot(),ack}).digest,frozen.bundle.digest)
  await f.network.local.request('/transfer/seal',{op,term,head})
  await f.network.cleanup()
  restarted=await authorityHttpFixture({storageFixture:f})
  await assert.rejects(restarted.local.request('/transfer/retain',{op:'remote-profile-stop',term}),/HTTP 409/)
  assert.equal((await restarted.local.request('/head')).home,'local')
  assert.equal(f.lease.status().expires_at,renewed.expires_at)
  assert.equal((await restarted.local.request('/transfer/status',{term})).state,'sealed')
  await restarted.local.request('/transfer/resume',{op,term})
  await restarted.local.request('/transfer/resume-input',{op,term})
  assert.equal((await restarted.local.request('/transfer/status',{term})).state,'open')
 }finally{await restarted?.cleanup();await frozen?.release();await handle?.close();const status=f.lease.status();if(status.holder==='local')f.lease.release('local',status.term);await f.cleanup()}
})
