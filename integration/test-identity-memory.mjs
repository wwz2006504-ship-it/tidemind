import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {createIdentityBinding} from './identity-binding.mjs'
import {createPersonaVersions} from './persona-versions.mjs'
import {createProtectedJsonMemory} from './protected-json-memory.mjs'
import {createMemoryStore} from '../host/aurabot/src/features/memory.js'
import memoryModule from '../host/aurabot/src/modules/memory/index.js'
import {aurabotHost} from './aurabot-host-fixture.mjs'
import {nativeDependencies} from './native-dependencies.mjs'
import {bindReadonlyIdentity} from '../host/aurabot/src/persona/personas.js'
import {createNativeHostBindings} from './native-host-bindings.mjs'
import {createSessionBindings} from './session-bindings.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex')
function setup(){const root=mkdtempSync(join(tmpdir(),'tide-identity-')),original=join(root,'original'),owned=join(root,'owned');mkdirSync(original);mkdirSync(owned);const persona=join(original,'synthetic.md'),memory=join(original,'memories.json');writeFileSync(persona,'\uFEFF---\r\nname: 汐羽合成\r\ntags: [原样，保留]\r\n---\r\n\r\nSYNTHETIC DISTINCT IDENTITY\r\n');writeFileSync(memory,JSON.stringify({rev:7,items:[{id:'old',text:'合成麦克风蓝色风铃',at:Date.now(),importance:.8,hits:3,source:'tool'}]}));const a=readFileSync(persona),b=readFileSync(memory),overlay=join(owned,'new-memories.json');let active=true;const storage=createProtectedJsonMemory({source:memory,expectedSha256:hash(b),overlay,ownedRoot:owned,withWriteGuard:fn=>{if(!active)throw Error('fenced');return fn()}});return {root,original,owned,persona,memory,overlay,a,b,storage,setActive:v=>active=v,identity:()=>createIdentityBinding({directory:original,selected:'synthetic',expectedSha256:hash(a)}),cleanup(){assert.deepEqual(readFileSync(memory),b);rmSync(root,{recursive:true,force:true})}}}
test('selected original persona preserves parser semantics with no seed, mutation or fallback',()=>{const f=setup();try{const i=f.identity();assert.equal(i.currentPersonaText('synthetic'),'SYNTHETIC DISTINCT IDENTITY');assert.equal(i.readPersona('synthetic').raw,f.a.toString());assert.deepEqual(i.listPersonas()[0].tags,['原样','保留']);i.seedPersonas();assert.throws(()=>i.currentPersonaText('other'),/selection/);assert.throws(()=>i.savePersona(),/read-only/);assert.throws(()=>i.deletePersona(),/read-only/);assert.deepEqual(readFileSync(f.persona),f.a);assert.equal(i.inspect().fallback,false)}finally{f.cleanup()}})
test('missing, empty, changed or traversing persona fails closed instead of using default identity',()=>{const f=setup();try{assert.throws(()=>createIdentityBinding({directory:f.original,selected:'../synthetic',expectedSha256:hash(f.a)}),/invalid/);assert.throws(()=>createIdentityBinding({directory:f.original,selected:'missing',expectedSha256:hash(f.a)}));const i=f.identity();writeFileSync(f.persona,'CHANGED');assert.throws(()=>i.currentPersonaText('synthetic'),/changed/);writeFileSync(f.persona,'  ');assert.throws(()=>createIdentityBinding({directory:f.original,selected:'synthetic',expectedSha256:hash(Buffer.from('  '))}),/empty/);assert.equal(existsSync(join(f.original,'missing.md')),false)}finally{f.cleanup()}})
test('original JSON remains readable; only new records persist and survive reopening',()=>{const f=setup();try{const s=f.storage.load();s.items.push({id:'new',text:'新的合成经历'});f.storage.save(s);assert.deepEqual(JSON.parse(readFileSync(f.overlay)).items,[{id:'new',text:'新的合成经历'}]);assert.equal(f.storage.load().items.length,2);assert.deepEqual(readFileSync(f.memory),f.b);const again=createProtectedJsonMemory({source:f.memory,expectedSha256:hash(f.b),overlay:f.overlay,ownedRoot:f.owned,withWriteGuard:fn=>fn()});assert.deepEqual(again.load().items,f.storage.load().items)}finally{f.cleanup()}})
test('semantic edits, deletion, withdrawal, supersession and stale authority cannot alter protected JSON records',()=>{const f=setup();try{for(const mutate of [s=>s.items.pop(),s=>s.items[0].text='替换',s=>s.items[0].invalidAt=1,s=>s.items[0].supersededBy='new']){const s=f.storage.load();mutate(s);assert.throws(()=>f.storage.save(s),/protected/)}f.setActive(false);assert.throws(()=>f.storage.save(f.storage.load()),/fenced/);assert.equal(existsSync(f.overlay),false)}finally{f.cleanup()}})
test('original memory search and recall counters do not write or change original baseline',()=>{const f=setup();try{const memory=createMemoryStore({storage:f.storage,getConfig:()=>({memory:{recallCount:6}})});assert.equal(memory.recall('麦克风')[0].it.id,'old');assert.equal(f.storage.load().items[0].hits,3);const added=memory.add({text:'完全不同的合成天文望远镜',importance:.7});assert.equal(added.ok,true);assert.equal(memory.list().length,2);assert.throws(()=>memory.update('old',{text:'被替换'}),/protected/);assert.equal(memory.update(added.id,{text:'新的合成独立记忆'}).ok,true);assert.equal(memory.remove(added.id).ok,true);assert.equal(memory.list().length,1)}finally{f.cleanup()}})
test('baseline drift and corrupt overlay stop retrieval rather than silently losing original memory',()=>{const f=setup();try{writeFileSync(f.overlay,'{invalid');assert.throws(()=>f.storage.load());rmSync(f.overlay);writeFileSync(f.memory,JSON.stringify({items:[]}));assert.throws(()=>f.storage.load(),/changed/);writeFileSync(f.memory,f.b)}finally{f.cleanup()}})
test('original host injects bound identity into both rules variables and original memory module uses protected storage',async()=>{const f=setup();let h;try{h=await aurabotHost({builtins:[memoryModule],dependencyOverrides:f.identity(),protectedMemory:f.storage,configPatch:{persona:{current:'synthetic'},memory:{enabled:true,recallCount:6}}});const p=await h.ctx.systemPrompt.assemble({scope:h.agent,agent:h.agent});assert.equal(p.variables.aurabot_persona,'SYNTHETIC DISTINCT IDENTITY');assert.match(p.variables.aurabot_rules_private,/电脑/);assert.match(p.variables.aurabot_rules_social,/没有任何电脑/);const response=await h.request('/memories');assert.equal(response.items[0].id,'old');await h.request('/memory/add',{text:'合成新的独立海洋知识'});assert.equal(f.storage.load().items.length,2);assert.match((await h.request('/memory/update',{id:'old',text:'不能替换'})).message,/protected/);assert.deepEqual(readFileSync(f.persona),f.a)}finally{if(h)await h.cleanup();f.cleanup()}})
test('all original native builtins plus task control mount without VM substitutes; original commands reply once through fenced outbox',async()=>{
 const f=setup(),off=bindReadonlyIdentity(f.identity());let h
 try{
  const dependencies=nativeDependencies();delete dependencies.createOneBotClient;delete dependencies.createSnowLumaManager;delete dependencies.openFolder
  h=await aurabotHost({builtins:dependencies.BUILTINS,dependencyOverrides:dependencies,protectedMemory:f.storage,configPatch:{persona:{current:'synthetic'},memory:{enabled:true,recallCount:6}}})
  for(const module of dependencies.BUILTINS)assert.equal(h.handle.modules.running(module.id),'builtin',module.id)
  const p=await h.ctx.systemPrompt.assemble({scope:h.agent,agent:h.agent});assert.equal(p.variables.aurabot_persona,'SYNTHETIC DISTINCT IDENTITY')
  await h.emit(h.event(81001,'/silent 1'));await h.handle.capabilities?.outbound?.idle?.()
  assert.equal(h.sent.length,1);assert.equal(h.requests.length,0)
  await h.emit(h.event(81001,'/silent 1'));assert.equal(h.sent.length,1)
  assert.equal((await h.request('/memories')).items[0].id,'old')
  assert.deepEqual(readFileSync(f.persona),f.a)
 }finally{if(h)await h.cleanup();off();f.cleanup()}
})
test('stale JSON overlay writers cannot overwrite a newer addition',()=>{const f=setup();try{const first=f.storage.load(),stale=f.storage.load();first.items.push({id:'newer',text:'保留新版本'});f.storage.save(first);stale.items.push({id:'older',text:'不得覆盖'});assert.throws(()=>f.storage.save(stale),/revision conflict/);assert.equal(f.storage.load().items[1].id,'newer')}finally{f.cleanup()}})
test('native binding factory mounts original host with existing session, identity, original memory module and one existing supervisor',async()=>{
 const original=setup();let h,binding,registry,sessionFile
 try{
  h=await aurabotHost({configPatch:{persona:{current:'synthetic'},memory:{enabled:true,recallCount:6}},prepareBindings:async({f,supervisor,paths,dependencies})=>{
   const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
   const persona=await import(pathToFileURL(base+'/dsh-persona/lib/index.js').href)
   persona.apply(f.agent.ctx,{prefix:'{{aurabot_persona}}\n\n{{aurabot_rules_private}}',complete:true})
   sessionFile=join(paths.TIDEMIND_AURABOT_DATA_ROOT,'sessions.json')
   writeFileSync(sessionFile,JSON.stringify({chats:{'private:20001':{sessionId:f.agent.id,preset:'aurabot-private',level:'full'}}}))
   registry=createSessionBindings({readMappings:()=>JSON.parse(readFileSync(sessionFile)),ownerQQ:'20001',resolveRegisteredAgent:id=>f.ctx.agents.get(id)})
   binding=createNativeHostBindings({authority:{lease:f.lease,gateway:f.gateway,holder:'local',term:f.term},identity:original.identity(),protectedMemory:original.storage,taskSupervisor:supervisor,activityAgent:f.agent,sessionBindings:registry,allowTargets:['private:20001','group:30001'],historyReader:createSessionHistoryReader(f.ctx.sessionPersistence),externalOverrides:{createOneBotClient:dependencies.createOneBotClient,createSnowLumaManager:dependencies.createSnowLumaManager,openFolder:dependencies.openFolder}})
   return binding.bindings
  }})
  assert.equal(registry.inspect().sessions,1)
  await h.emit(h.event(81005,'麦克风 合成新会话接线'));await h.settle()
  assert.equal(h.sent.length,1);assert.equal(h.errors.length,0)
  assert.equal(h.handle.modules.running('memory'),'builtin')
  assert.match(JSON.stringify(h.requests[0].messages),/SYNTHETIC DISTINCT IDENTITY/);assert.ok(!JSON.stringify(h.requests[0].messages).includes('SYNTHETIC IDENTITY ONLY'))
  await h.request('/memory/add',{text:'合成新的候选工厂记忆'});assert.equal(original.storage.load().items.length,2)
  const created=await h.controller.create({sessionId:'synthetic-social-session',cwd:h.root}),resolved=await h.controller.resolveAgent(created.sessionId);assert.ok(!resolved.error)
  const social=resolved.agent,base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
  const persona=await import(pathToFileURL(base+'/dsh-persona/lib/index.js').href)
  persona.apply(social.ctx,{prefix:'{{aurabot_persona}}\n\n{{aurabot_rules_social}}',complete:true})
  const mappings=JSON.parse(readFileSync(sessionFile));mappings.chats['group:30001']={sessionId:social.id,preset:'aurabot-social',level:'social'};writeFileSync(sessionFile,JSON.stringify(mappings))
  await h.emit({...h.event(81007,'SYNTHETIC SOCIAL'),message_type:'group',group_id:30001,message:[{type:'at',data:{qq:'10001'}},{type:'text',data:{text:'SYNTHETIC SOCIAL'}}]})
  for(let i=0;i<300&&(h.requests.length<2||social.status!=='idle'||h.sent.length<2);i++)await new Promise(r=>setTimeout(r,5))
  assert.equal(h.requests.length,2);assert.equal(h.sent.length,2);assert.equal(registry.inspect().sessions,2)
  const system=JSON.stringify(h.requests[1].messages.filter(m=>m.role==='system'))
  assert.match(system,/SYNTHETIC DISTINCT IDENTITY/);assert.match(system,/没有任何电脑操作能力/);assert.ok(!system.includes('你的手能碰到电脑'))

 }finally{if(h)await h.cleanup();binding?.dispose();original.cleanup()}
})
test('native self-control versions round-trip protected JSON through original memory API without a raw memories.json bypass',async()=>{
 const original=setup(),off=bindReadonlyIdentity(original.identity());let h,dataRoot
 try{
  h=await aurabotHost({builtins:[memoryModule],protectedMemory:original.storage,dependencyOverrides:original.identity(),configPatch:{persona:{current:'synthetic'},memory:{enabled:true,recallCount:6}},prepareModules:async({f,paths})=>{
   dataRoot=paths.TIDEMIND_AURABOT_DATA_ROOT
   const room=join(f.root,'room'),dir=join(dataRoot,'modules/xiyu-self-control');mkdirSync(join(room,'bridge'),{recursive:true});mkdirSync(dir,{recursive:true});writeFileSync(join(room,'project.godot'),'SYNTHETIC');writeFileSync(join(dir,'connection.json'),JSON.stringify({room_dir:room}))
   return {modules:[{id:'xiyu-self-control',source:readFileSync(new URL('../host/custom-modules/xiyu-self-control/index.mjs',import.meta.url),'utf8')}]}
  }})
  await h.emit(h.event(81006,'SYNTHETIC OWNER'));await h.settle()
  const invoke=async(name,args,callId)=>{const result=await h.agent.ctx.tools.execute({name,arguments:args,callId,agent:h.agent,signal:new AbortController().signal});assert.ok(!result.isError,JSON.stringify(result));return result.value}
  const add=await invoke('xiyu_local_memory',{action:'add',text:'完全独立的合成星际航行知识'},'json-version-add');assert.equal(add.ok,true,JSON.stringify(add));assert.equal(original.storage.load().items.length,2)
  const rev=original.storage.load()._tideOverlayRevision
  const restore=await invoke('xiyu_versions',{action:'restore',version_id:add.version_id},'json-version-restore');assert.equal(restore.ok,true,JSON.stringify(restore));assert.equal(original.storage.load().items.length,1);assert.ok(original.storage.load()._tideOverlayRevision>rev)
  const redo=await invoke('xiyu_versions',{action:'restore',version_id:restore.version_id},'json-version-redo');assert.equal(redo.ok,true);assert.equal(original.storage.load().items.length,2)
  assert.equal(existsSync(join(dataRoot,'memories.json')),false);assert.deepEqual(readFileSync(original.memory),original.b)
 }finally{if(h)await h.cleanup();off();original.cleanup()}
})
test('compatibility host recreation reads new SQLite and JSON memories with unchanged original identity and inputs',async()=>{
 const original=setup();let first,second,binding,closed=false
 const prepareBindings=async({f,supervisor,paths,dependencies})=>{
  const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai',persona=await import(pathToFileURL(base+'/dsh-persona/lib/index.js').href)
  persona.apply(f.agent.ctx,{prefix:'{{aurabot_persona}}\n\n{{aurabot_rules_private}}',complete:true})
  const mapFile=join(paths.TIDEMIND_AURABOT_DATA_ROOT,'sessions.json');writeFileSync(mapFile,JSON.stringify({chats:{'private:20001':{sessionId:f.agent.id,preset:'aurabot-private',level:'full'}}}))
  const registry=createSessionBindings({readMappings:()=>JSON.parse(readFileSync(mapFile)),ownerQQ:'20001',resolveRegisteredAgent:id=>f.ctx.agents.get(id)})
  const storage=createProtectedJsonMemory({source:original.memory,expectedSha256:hash(original.b),overlay:original.overlay,ownedRoot:original.owned,withWriteGuard:fn=>fn()})
  binding=createNativeHostBindings({authority:{lease:f.lease,gateway:f.gateway,holder:'local',term:f.term},identity:original.identity(),protectedMemory:storage,taskSupervisor:supervisor,activityAgent:f.agent,sessionBindings:registry,allowTargets:['private:20001'],historyReader:createSessionHistoryReader(f.ctx.sessionPersistence),externalOverrides:{createOneBotClient:dependencies.createOneBotClient,createSnowLumaManager:dependencies.createSnowLumaManager,openFolder:dependencies.openFolder}})
  return binding.bindings
 }
 const options={prepareBindings,configPatch:{persona:{current:'synthetic'},memory:{enabled:true,recallCount:6}}}
 try{
  first=await aurabotHost(options);await first.emit(first.event(81008,'麦克风 我喜欢合成蓝色风铃'));await first.settle()
  assert.equal((await first.request('/memory/add',{text:'我有一架新的合成红色望远镜'})).ok,true)
  const rows=first.read('SELECT id,content,status,valid_to,superseded_by,updated_at FROM memories ORDER BY id'),head=first.gateway.head(first.lease),overlay=readFileSync(original.overlay)
  await first.unmount();await first.supervisor.close();await first.closeRuntime();binding.dispose();binding=null;closed=true
  second=await aurabotHost({...options,storageFixture:first.storageFixture,resumeSessionId:first.agent.id})
  assert.deepEqual(second.read('SELECT id,content,status,valid_to,superseded_by,updated_at FROM memories ORDER BY id'),rows)
  assert.equal(second.gateway.head(second.lease).revision,head.revision);assert.deepEqual(readFileSync(original.overlay),overlay)
  await second.emit(second.event(81009,'红色望远镜'));await second.settle()
  assert.match(JSON.stringify(second.requests[0].messages),/新的合成红色望远镜/);assert.match(JSON.stringify(second.requests[0].messages),/SYNTHETIC DISTINCT IDENTITY/)
  assert.deepEqual(readFileSync(original.persona),original.a);assert.deepEqual(readFileSync(original.memory),original.b)
 }finally{if(second)await second.cleanup();else if(first){if(closed)first.storageFixture.cleanup();else await first.cleanup()}binding?.dispose();original.cleanup()}
})
test('original persona-self and self-control edit/restore independent versions and actual prompt without touching original persona',async()=>{
 const original=setup(),versions=createPersonaVersions({identity:original.identity(),ownedRoot:original.owned,stateFile:join(original.owned,'persona-versions.json'),withWriteGuard:fn=>fn()});let h,binding,writeTerm
 try{
  h=await aurabotHost({configPatch:{persona:{current:'synthetic',selfEdit:true,selfEditPerDay:10},memory:{enabled:true,recallCount:6}},prepareModules:async({f,paths})=>{
   const dir=join(paths.TIDEMIND_AURABOT_DATA_ROOT,'modules/xiyu-self-control'),room=join(f.root,'room');mkdirSync(dir,{recursive:true});mkdirSync(join(room,'bridge'),{recursive:true});writeFileSync(join(room,'project.godot'),'SYNTHETIC');writeFileSync(join(dir,'connection.json'),JSON.stringify({room_dir:room}))
   return {modules:[{id:'xiyu-self-control',source:readFileSync(new URL('../host/custom-modules/xiyu-self-control/index.mjs',import.meta.url),'utf8')}]}
  },prepareBindings:async({f,supervisor,paths,dependencies})=>{
   const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai',persona=await import(pathToFileURL(base+'/dsh-persona/lib/index.js').href);persona.apply(f.agent.ctx,{prefix:'{{aurabot_persona}}\n\n{{aurabot_rules_private}}',complete:true})
   const mapFile=join(paths.TIDEMIND_AURABOT_DATA_ROOT,'sessions.json');writeFileSync(mapFile,JSON.stringify({chats:{'private:20001':{sessionId:f.agent.id,preset:'aurabot-private',level:'full'}}}))
   const registry=createSessionBindings({readMappings:()=>JSON.parse(readFileSync(mapFile)),ownerQQ:'20001',resolveRegisteredAgent:id=>f.ctx.agents.get(id)})
   writeTerm=f.term;binding=createNativeHostBindings({authority:{lease:f.lease,gateway:f.gateway,term:()=>writeTerm,holder:'local'},identity:versions,protectedMemory:original.storage,taskSupervisor:supervisor,activityAgent:f.agent,sessionBindings:registry,allowTargets:['private:20001'],historyReader:createSessionHistoryReader(f.ctx.sessionPersistence),externalOverrides:{createOneBotClient:dependencies.createOneBotClient,createSnowLumaManager:dependencies.createSnowLumaManager,openFolder:dependencies.openFolder}})
   return binding.bindings
  }})
  await h.emit(h.event(18101,'SYNTHETIC OWNER'));await h.settle()
  const invoke=async(name,args,callId)=>{const result=await h.agent.ctx.tools.execute({name,arguments:args,callId,agent:h.agent,signal:new AbortController().signal});assert.ok(!result.isError,JSON.stringify(result));assert.equal(result.value.ok,true,JSON.stringify(result.value));return result.value}
  const edited=await invoke('xiyu_persona',{action:'append',body:'SYNTHETIC INDEPENDENT PERSONA VERSION'},'persona-version-1')
  await invoke('persona_edit',{old_text:'INDEPENDENT',new_text:'NATIVE'},'persona-version-2');assert.equal(versions.inspect().overlayVersion,2)
  await h.emit(h.event(18102,'SYNTHETIC READ NEW IDENTITY'));await h.settle(2);assert.match(JSON.stringify(h.requests[1].messages),/SYNTHETIC NATIVE PERSONA VERSION/)
  await invoke('xiyu_versions',{action:'restore',version_id:edited.version_id},'persona-version-restore');assert.equal(versions.currentPersonaText('synthetic'),'SYNTHETIC DISTINCT IDENTITY');assert.equal(versions.inspect().overlayVersion,3)
  writeTerm=h.term-1
  assert.throws(()=>binding.bindings.dependencies.savePersona('synthetic',{body:'STALE'}),/FENCED/)
  writeTerm=h.term
  assert.deepEqual(readFileSync(original.persona),original.a)
 }finally{if(h){writeTerm=h.term;await h.cleanup()}binding?.dispose();original.cleanup()}
})
