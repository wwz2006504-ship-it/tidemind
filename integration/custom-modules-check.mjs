// Original custom module sources; synthetic in-memory filesystem and offline process/network adapters.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs'
import path from 'node:path'
import * as crypto from 'node:crypto'
import {EventEmitter} from 'node:events'
import {ChildProcess} from 'node:child_process'
import {stopOwnedChild} from './owned-child-exit.mjs'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {inflateRawSync} from 'node:zlib'
import {isIP} from 'node:net'
import {normalize} from '../host/aurabot/src/core/config.js'
import {buildWav} from '../host/aurabot/src/voice/wav.js'
import {qqFixture} from './qq-fixture.mjs'
import {createModules,lazyProxy} from '../host/aurabot/src/core/modules.js'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
import {aurabotHost} from './aurabot-host-fixture.mjs'
const base=new URL('../host/custom-modules/',import.meta.url)
const names=['autonomous-desktop','live-vision-v1','local-vision','voice-ear','my-agent-minecraft','my-agent-room-mcp','my-agent-room3d','my-agent-self-control','my-agent-voice-reference']
const builtinNames=['stickers','voice','mood','memory','qq-tools','group-admin','imagegen','diary','qzone-social','speakup','bili','phone','persona-self','pet-link','song']
const upstream=new URL('../host/aurabot-upstream/src/',import.meta.url)
const candidateVoice={
 'modules/voice/index.js':readFileSync(new URL('../host/aurabot/src/modules/voice/index.js',import.meta.url),'utf8'),
 'voice/tts.js':readFileSync(new URL('../host/aurabot/src/voice/tts.js',import.meta.url),'utf8'),
}
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({dryRun:true,modules:names,originalDataAccess:false}));process.exit(0)}
if(process.argv.includes('--rollback')){console.log('NO-OP: all module state is synthetic and in-memory; no production activation.');process.exit(0)}
const mcNames=['get_connection_status','get_observation','get_state','get_inventory','list_players','list_entities','get_entity_details','pathfinder_status','get_events','get_game_task_status','follow_owner','come_to_owner','stop_motion','get_motion_status','gather_wood','craft_planks','get_work_status']
const roomNames=['add_item','remove_item','set_lighting','clear_room','export_svg','get_room_state']
export async function loadModule(id,{mount,bootstrapAgent,sourceRoot=base,entry=id+'/index.mjs',sharedFiles,sourceOverrides={},fetchHandler,closeHandler}={}){
 const files=sharedFiles||new Map(),writes=[],network=[],children=[],remotes=[],timers=new Set(),callbacks=[],builders=[],routes=new Map(),events=new Map(),commands=[],rules=[]
 let alias=null
 const canonical=p=>path.resolve(String(p)).replaceAll('\\','/')
 const norm=p=>{const value=canonical(p);return alias&&value.startsWith(alias+'/')?canonical('/synthetic/modules/'+id)+value.slice(alias.length):value},put=(p,v)=>files.set(norm(p),Buffer.isBuffer(v)?Buffer.from(v):Buffer.from(typeof v==='string'?v:JSON.stringify(v)))
 const dir='/synthetic/modules/'+id,room='/synthetic/room',runtime='/synthetic/runtime',session='/synthetic/session.json'
 const cfg=normalize({enabled:true,dryRun:false,ownerQQ:'20001',ownerLevel:'full',persona:{current:'default'}})
 put(dir+'/connection.json',{runtime_dir:runtime,runtimeDir:runtime,stateDir:runtime,room_dir:room,room_connection_file:'/synthetic/room-connection.json',sessionId:'session-test',nodeExecutable:'synthetic-node',node_executable:'synthetic-node',port:19999,installation_id:'synthetic'})
 put('/synthetic/room-connection.json',{room_dir:room});put(room+'/project.godot','synthetic')
 put(room+'/bridge/room_presence.json',{updated_at:new Date().toISOString(),manual_pause:false});put(room+'/bridge/state.json',{updated_at:new Date().toISOString()})
 put(runtime+'/data/room-state.json',{items:[],lighting:'morning'})
 put(dir+'/session-path.txt',session);put(session,{token:'s'.repeat(48)})
 put(dir+'/request.json',{statusFile:'/synthetic/voice-status.json'});put(dir+'/applied.json',{status:'applied',synthetic:true})
 put('C:/Users/test-user/.dsh/plugins-data/aurabot/config.json',cfg)
 put('/synthetic/data/memories.json',{rev:1,items:[{id:'a',text:'SYNTHETIC MEMORY'}]})
 put('/synthetic/data/personas/synthetic.md','---\nname: synthetic\ntags: []\n---\nSYNTHETIC PERSONA')
 put('/synthetic/data/personas/default.md','---\nname: synthetic\ntags: []\n---\nSYNTHETIC PERSONA')
 let active=true,httpResponse={ok:true,untrusted:true,summary:'SYNTHETIC SCREEN',expires_ms:1000},ack=true
 const fs={
  readFileSync(p,encoding){const value=files.get(norm(p));if(!value)throw Error('synthetic file missing');return encoding?value.toString('utf8'):Buffer.from(value)},
  copyFileSync(a,b){fs.writeFileSync(b,fs.readFileSync(a))},statfsSync:()=>({bsize:4096,bavail:100000}),rmSync(p){const value=norm(p);for(const key of files.keys())if(key===value||key.startsWith(value+'/'))files.delete(key)},
  writeFileSync(p,value){put(p,value);writes.push(norm(p));
   if(ack&&norm(p).endsWith('/command.json')){const cmd=JSON.parse(Buffer.from(value).toString());put(room+'/bridge/ack.json',{command_id:cmd.command_id,status:'applied'})}},
  appendFileSync(p,value){put(p,Buffer.concat([files.get(norm(p))||Buffer.alloc(0),Buffer.from(value)]));writes.push(norm(p))},
  existsSync:p=>files.has(norm(p)),mkdirSync(){},realpathSync:p=>norm(p),
  statSync(p){const b=files.get(norm(p));if(!b)throw Error('synthetic file missing');return {size:b.length}},
  renameSync(a,b){const value=fs.readFileSync(a);files.delete(norm(a));fs.writeFileSync(b,value)},
  readdirSync:p=>[...files.keys()].filter(k=>k.startsWith(norm(p)+'/')&&!k.slice(norm(p).length+1).includes('/')).map(k=>k.slice(norm(p).length+1)),
  unlinkSync:p=>files.delete(norm(p)),openSync:p=>norm(p),closeSync(){},
  readSync(fd,buffer,offset,length,position){return fs.readFileSync(fd).copy(buffer,offset,position,position+length)},
 }
 const spawn=()=>{const child=new ChildProcess();child.pid=999;child.exitCode=null;child.killed=false;child.kill=()=>{child.killed=true;child.exitCode=0;child.emit('exit',0)};children.push(child);return child}
 const http={request(options,receive){network.push(options.path);const req=new EventEmitter();req.destroy=()=>{};req.setTimeout=()=>{};req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;receive(res);res.emit('data',JSON.stringify(httpResponse));res.emit('end')});return req}}
 class Client{async connect(){}async listTools(){return {tools:(id==='my-agent-room-mcp'?roomNames:mcNames).map(name=>({name,description:'synthetic '+name,inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}))}}async callTool(request){remotes.push(request);return {content:[{type:'text',text:'SYNTHETIC ACK'}],structuredContent:{connected:true}}}async close(){await closeHandler?.('client')}}
 class Transport{stderr=new EventEmitter();async close(){await closeHandler?.('transport')}}
 const requireMock=value=>{const p=String(value).replaceAll('\\','/');return p.endsWith('/catalog.js')?{catalog:{}}:p.includes('/client/index.js')?{Client}:p.includes('/stdio.js')?{StdioClientTransport:Transport}:p.includes('/streamableHttp.js')?{StreamableHTTPClientTransport:Transport}:(()=>{throw Error('unmocked require')})()}
 const smallTimers=new Set()
 let clockNow=null
 class TestDate extends Date{constructor(...args){super(...(args.length?args:[clockNow??Date.now()]))}static now(){return clockNow??Date.now()}}
 const context=vm.createContext({Date:TestDate,Buffer,URL,URLSearchParams,FormData,Blob,AbortSignal,TextDecoder,TextEncoder,console:{log(){},warn(){},error(){}},process:{pid:1,platform:'win32',env:{SystemRoot:'synthetic',PATH:'',AURABOT_DATA_DIR:'/synthetic/data',DSH_HOME:'/synthetic/home'}},fetch:async(url,init)=>{network.push(String(url));if(fetchHandler)return fetchHandler(url,init);return {ok:true,json:async()=>({service:'my-agent-room-mcp',installation_id:'synthetic'})}},
  setTimeout(fn,ms){if(ms<=150){const t=setTimeout(()=>{smallTimers.delete(t);fn()},1);smallTimers.add(t);return t}const token={fn};timers.add(token);return token},clearTimeout(t){timers.delete(t);smallTimers.delete(t);clearTimeout(t)},setInterval(fn){const token={fn};timers.add(token);return token},clearInterval:t=>timers.delete(t)})
 const cache=new Map()
 async function synthetic(key,value){if(cache.has(key))return cache.get(key);const keys=[...new Set(['default',...Object.keys(value)])];const m=new vm.SyntheticModule(keys,function(){this.setExport('default',value);for(const k of Object.keys(value))this.setExport(k,value[k])},{context});cache.set(key,m);return m}
 async function source(relative){if(cache.has(relative))return cache.get(relative);const code=sourceOverrides[relative]??readFileSync(new URL(relative,sourceRoot),'utf8');const m=new vm.SourceTextModule(code,{context,identifier:relative,initializeImportMeta(meta){meta.url=pathToFileURL(path.resolve('/synthetic-src',relative)).href}});cache.set(relative,m);await m.link(async(spec,ref)=>{
  if(spec==='node:fs')return synthetic(spec,fs)
  if(spec==='node:path')return synthetic(spec,path)
  if(spec==='node:crypto')return synthetic(spec,crypto)
  if(spec==='node:http')return synthetic(spec,http)
  if(spec==='node:child_process')return synthetic(spec,{spawn,execFile:(...args)=>{const cb=args.findLast(v=>typeof v==='function');queueMicrotask(()=>cb?.(null,'SYNTHETIC',''));return new EventEmitter()},execSync:()=>Buffer.from('SYNTHETIC')})
  if(spec==='node:module')return synthetic(spec,{createRequire:()=>requireMock})
  if(spec==='node:os')return synthetic(spec,{homedir:()=>'/synthetic/home'})
  if(spec==='node:url')return synthetic(spec,{fileURLToPath,pathToFileURL})
  if(spec==='node:util')return synthetic(spec,{promisify})
  if(spec==='node:zlib')return synthetic(spec,{inflateRawSync})
  if(spec==='node:net')return synthetic(spec,{isIP})
  if(spec==='node:dns/promises')return synthetic(spec,{lookup:async()=>({address:'127.0.0.1',family:4})})
  if(spec.startsWith('./')||spec.startsWith('../'))return source(path.posix.join(path.posix.dirname(ref.identifier),spec))
  throw Error('unmocked import '+spec)
 });return m}
 const module=await source(entry);await module.evaluate();const definition=module.namespace.default
 let settings={...definition.defaults},persona={name:'synthetic',tags:[],body:'SYNTHETIC IDENTITY'},pushes=0
 const localMemory={list:()=>JSON.parse(fs.readFileSync('/synthetic/data/memories.json','utf8')).items,add(item){const data=JSON.parse(fs.readFileSync('/synthetic/data/memories.json','utf8'));data.items.push({id:crypto.randomUUID(),...item});fs.writeFileSync('/synthetic/data/memories.json',JSON.stringify(data));return {ok:true}}}
 const native=new Map(['lmem_search','lmem_write','lmem_update','lmem_forget','lmem_review','lmem_admin'].map(name=>[name,{execute:async args=>{if(name==='lmem_admin'&&args.action==='backup'){put('/synthetic/layer.db','SYNTHETIC DB');return {ok:true,file:'/synthetic/layer.db'}}return {ok:true,synthetic:true}}}]))
 const api={id,dir,core:{hub:{turnHasOwner:()=>true,pushToSession:async()=>{pushes++},lastOwnerChatAt:0,lastBotToOwner:{at:0},sessions:()=>({})},mutes:{muted:()=>false},onebot:{call:async()=>({})},local:{active:()=>false},groupRoles:{peek:()=>null,get:async()=>({role:'owner'}),canManage:()=>true,label:()=> 'owner'},http:{body:async()=>({}),query:()=>({}),send(){}},root:'/synthetic-src',listModels:async()=>[]},
  config:()=>cfg,settings:()=>settings,saveSettings:p=>{settings={...settings,...p}},log:{info(){},warn(){},error(){}},isOwner:u=>String(u)==='20001',
  assertActivity:()=>{assert.ok(active,'module inactive')},registerTool:(agent,t)=>agent.ctx.tools.register({...t,execute:(...args)=>{assert.ok(active,'module inactive');return t.execute(...args)}}),
  dataDir:(...parts)=>'/synthetic/data/'+parts.join('/'),defineTool:d=>({...d,parameters:{type:'object',properties:d.properties||{},required:d.required||[]}}),
  tool:b=>builders.push(b),context(){},rule:r=>rules.push(r),command:c=>commands.push(c),route:(p,h)=>routes.set(p,h),
  every:(ms,fn)=>{const item={ms,fn};timers.add(item);return ()=>timers.delete(item)},later:(ms,fn)=>{const item={ms,fn};timers.add(item);return ()=>timers.delete(item)},on:(e,fn)=>events.set(e,fn),onDispose:fn=>callbacks.push(fn),stopOwnedChild,
  lib:key=>key==='persona/personas.js'?{readPersona:()=>({...persona}),savePersona:(id,p)=>{persona={...p}}}:key==='core/store.js'?{dataDir:()=>'/synthetic/data/memories.json'}:(()=>{throw Error('unmocked lib')})(),
  use:key=>key==='memory'?localMemory:null,lazy:key=>lazyProxy(()=>key==='memory'?localMemory:null),emit(){},dsh:{agents:new Map(bootstrapAgent?[['test',bootstrapAgent]]:[]),get:name=>name==='tools'?{get:n=>native.get(n)}:null},sendImage:async()=>({message_id:1}),
 }
 const exported=(await (mount?mount(definition,api,{put,setAlias:value=>{alias=canonical(value)}}):definition.setup(api)))??{}
 const owner={chat:{kind:'private',userId:'20001',chatId:'private:20001'},level:'full',sessionId:'session-test'},exec={agent:{id:'session-test',session:{id:'session-test'}},callId:'synthetic-call'}
 const tools=(where=owner)=>builders.flatMap(b=>typeof b==='function'?b(where):b||[])
 const invoke=(name,args={})=>{assert.ok(active,'test module already disposed');const t=tools().find(t=>t.name===name);assert.ok(t,'missing tool '+name);return t.execute(args,exec)}
 const dispose=async()=>{if(!active)return;active=false;for(const cb of callbacks.reverse())await cb();for(const t of smallTimers)clearTimeout(t);smallTimers.clear();timers.clear()}
 return {id,definition,module,api,exported,files,fs,writes,network,children,remotes,timers,commands,rules,owner,exec,tools,invoke,put,dispose,setAlias:value=>{alias=canonical(value)},namespace:key=>cache.get(key)?.namespace,setNow:value=>{clockNow=value},setHttp:v=>{httpResponse=v},setAck:v=>{ack=v},persona:()=>persona,pushes:()=>pushes}
}

for(const id of names)test('original '+id+' initializes and disposes with synthetic dependencies',async()=>{const f=await loadModule(id);try{assert.equal(f.definition.id,id);assert.ok(f.exported);if(id==='my-agent-minecraft')assert.equal(f.exported.status().phase,'ready');if(id==='my-agent-room-mcp')assert.equal(f.exported.status().status,'ready');for(const t of f.tools())assert.equal(typeof t.execute,'function')}finally{await f.dispose()}assert.equal(f.timers.size,0);assert.ok(f.children.every(c=>c.killed))})

test('candidate Minecraft disposal waits both MCP close operations and preserves unconfirmed failure',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve}),seen=[]
 const f=await loadModule('my-agent-minecraft',{closeHandler:async kind=>{seen.push(kind);await gate}})
 try{let ended=false;const closing=f.dispose().then(()=>{ended=true});await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(seen.sort(),['client','transport']);assert.equal(ended,false);assert.equal(f.exported.status().phase,'stopping');release();await closing;assert.equal(f.exported.status().phase,'stopped')}finally{release();await f.dispose()}
 const failed=await loadModule('my-agent-minecraft',{closeHandler:async()=>{throw Error('SYNTHETIC CLOSE FAILED')}})
 await assert.rejects(failed.dispose(),/shutdown unconfirmed/);assert.equal(failed.exported.status().phase,'stop-unconfirmed')
})

test('candidate ear disposal waits actual exit event rather than kill request',async()=>{
 const f=await loadModule('voice-ear'),child=f.children[0];let stopped=false
 child.kill=()=>{child.killed=true;return true}
 const closing=f.dispose().then(()=>{stopped=true});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false)
 child.exitCode=0;child.emit('exit',0);await closing;assert.equal(stopped,true);assert.equal(f.children.length,1)
})

test('self-control persona and JSON backup/restore round trip preserves synthetic content',async()=>{const f=await loadModule('my-agent-self-control');try{
 const before=f.persona().body;const write=await f.invoke('my-agent_persona',{action:'append',body:'SYNTHETIC ADDITION'});assert.equal(write.ok,true);assert.notEqual(f.persona().body,before)
 const restored=await f.invoke('my-agent_versions',{action:'restore',version_id:write.version_id});assert.equal(restored.ok,true);assert.equal(f.persona().body,before)
 const memoryBefore=JSON.parse(f.fs.readFileSync('/synthetic/data/memories.json','utf8'));const add=await f.invoke('my-agent_local_memory',{action:'add',text:'SYNTHETIC NEW'});assert.equal(add.ok,true)
 assert.equal((await f.invoke('my-agent_versions',{action:'restore',version_id:add.version_id})).ok,true)
 const memoryAfter=JSON.parse(f.fs.readFileSync('/synthetic/data/memories.json','utf8'));assert.deepEqual(memoryAfter.items,memoryBefore.items);assert.ok(memoryAfter.rev>memoryBefore.rev)
 const invalid=await f.invoke('my-agent_versions',{action:'restore',version_id:'../../live'});assert.equal(invalid.ok,false)
}finally{await f.dispose()}})

test('original room3d waits for matching ACK and rejects foreign/private scope',async()=>{const f=await loadModule('my-agent-room3d');try{assert.equal(f.tools({...f.owner,chat:{kind:'group',groupId:'30001'}}).length,0);assert.equal((await f.invoke('my-agent_room3d',{action:'move_character',target:'desk'})).ok,true)}finally{await f.dispose()}})

test('room shutdown waits matching physical ACK and never reports stopped before it arrives',async()=>{
 const f=await loadModule('my-agent-room3d');f.setAck(false)
 const action=f.invoke('my-agent_room3d',{action:'move_character',target:'desk'})
 await new Promise(resolve=>setTimeout(resolve,10))
 const pending=JSON.parse(f.fs.readFileSync('/synthetic/room/bridge/tidemind-pending-command.json','utf8'))
 let stopped=false;const stop=f.dispose().then(()=>{stopped=true})
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false)
 f.put('/synthetic/room/bridge/ack.json',{command_id:'foreign',status:'applied'})
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(stopped,false)
 f.put('/synthetic/room/bridge/ack.json',{command_id:pending.command_id,status:'applied'})
 assert.equal((await action).ok,true);await stop
 assert.equal(f.exported.transferStatus().quiet,true);assert.equal(f.fs.existsSync('/synthetic/room/bridge/tidemind-pending-command.json'),false)
})

test('unconfirmed room operation survives reload, blocks shutdown and cannot be overwritten by a new action',async()=>{
 const f=await loadModule('my-agent-room3d');f.setAck(false)
 assert.equal((await f.invoke('my-agent_room3d',{action:'move_character',target:'desk'})).ok,false)
 const file='/synthetic/room/bridge/command.json',before=f.fs.readFileSync(file,'utf8'),pending=f.exported.status().pending_command
 await assert.rejects(f.dispose(),/outcome unconfirmed/)
 const restored=await loadModule('my-agent-room3d',{sharedFiles:f.files});try{
  assert.equal(restored.exported.status().pending_command,pending)
  assert.equal((await restored.invoke('my-agent_room3d',{action:'move_character',target:'window'})).ok,false)
  assert.equal(restored.fs.readFileSync(file,'utf8'),before)
  restored.put('/synthetic/room/bridge/ack.json',{command_id:pending,status:'applied'})
  await restored.dispose();assert.equal(restored.exported.transferStatus().quiet,true)
 }finally{await restored.dispose()}
})

test('original local vision responds to synthetic evidence and becomes inactive on dispose',async()=>{const f=await loadModule('local-vision');try{assert.equal(await f.exported.observe(),'SYNTHETIC SCREEN');await f.dispose();assert.equal(await f.exported.observe(),null)}finally{await f.dispose()}})

test('original live vision tools retain evidence checks and reject untrusted response shape',async()=>{const f=await loadModule('live-vision-v1');try{assert.ok(f.tools().some(t=>t.name==='my-agent_video_status'));const r=await f.invoke('my-agent_video_observe',{question:'synthetic'});assert.equal(r.ok,false);assert.equal(f.tools({...f.owner,level:'social'}).length,0)}finally{await f.dispose()}})

test('original Minecraft binds actual session and never calls remote for foreign execution',async()=>{const f=await loadModule('my-agent-minecraft');try{const t=f.tools().find(t=>t.name.endsWith('__get_state'));assert.ok(t);const before=f.remotes.length;const r=await t.execute({},{agent:{id:'foreign',session:{id:'foreign'}}});assert.equal(r.ok,false);assert.equal(f.remotes.length,before);assert.equal((await f.invoke(t.name)).ok,true)}finally{await f.dispose()}})

async function kernelFixture(id){
 const f=await qqFixture();let mods,loaded
 try{
  loaded=await loadModule(id,{mount:async(def,api,helpers)=>{
   const directory=path.join(process.env.TIDEMIND_AURABOT_DATA_ROOT,'modules',id);mkdirSync(directory,{recursive:true})
   const pins=JSON.parse(readFileSync(new URL('SOURCE-MANIFEST.json',base),'utf8'))
   for(const name of Object.keys(pins).filter(name=>name.startsWith(id+'/')))copyFileSync(new URL(name,base),path.join(directory,path.basename(name)))
   helpers.setAlias(directory)
   if(id==='my-agent-minecraft'){
    const config={runtimeDir:'/synthetic/runtime',stateDir:'/synthetic/runtime',sessionId:f.agent.id,nodeExecutable:'synthetic-node'}
    helpers.put(path.join(directory,'connection.json'),config)
    api.dsh.agents.set(f.agent.id,f.agent)
   }
   let cfg={...api.config(),safeMode:false,modules:{},ext:{}}
   const c=createOneBotCapabilities({...f,selfId:10001,allowTargets:['private:20001'],transport:async()=>assert.fail('no real QQ capability used')})
   const log={child(){return this},info(){},warn(){},error(){},debug(){}}
   mods=createModules({ctx:api.dsh,core:api.core,getConfig:()=>cfg,setConfig:v=>{cfg=v},logger:log,version:'synthetic',builtins:[{id:'memory',setup:()=>api.use('memory')}],
    moduleLib:api.lib,importModule:async url=>{assert.ok(url.includes('.aurabot-cache'));return {default:def}},wrapTool:(t,options)=>c.wrapAutonomousTool(t,options)})
   await mods.boot();assert.equal(mods.running(id),'user');return mods.use(id)
  }})
  const where={chat:{kind:'private',userId:'20001',chatId:'private:20001'},level:'full',sessionId:f.agent.id}
  return {f,mods,loaded,tools:()=>mods.buildTools(where),cleanup:async()=>{mods.dispose();await loaded.dispose();await f.cleanup()}}
 }catch(error){mods?.dispose();if(loaded)await loaded.dispose();await f.cleanup();throw error}
}

for(const id of names)test('original module kernel loads and unloads custom '+id,async()=>{
 const h=await kernelFixture(id);try{
  assert.equal(h.mods.running(id),'user')
  const before=h.tools();h.mods.stop(id);assert.ok(!h.mods.running(id))
  for(const old of before)await assert.rejects(old.execute({},{agent:h.f.agent,callId:'stale-custom'}),/stopped or replaced/)
 }finally{await h.cleanup()}
})

test('original custom Minecraft tool through module kernel runs in actual DSH ToolRuntime',async()=>{
 const h=await kernelFixture('my-agent-minecraft');try{
  const name='mcp__my-agent_minecraft_v2__get_state'
  assert.ok(h.f.ctx.tools.get(name,h.f.agent))
  const result=await h.f.call(name,{},'native-custom-minecraft');assert.ok(result.value,JSON.stringify(result));assert.equal(result.value.ok,true)
  assert.ok(h.loaded.remotes.some(r=>r.name==='get_state'))
 }finally{await h.cleanup()}
})

test('candidate Minecraft bootstrap uses supplied host registration hook and unloads all registrations',async()=>{
 const registered=[];let released=0
 const agent={ctx:{tools:{schemas:()=>[],register:tool=>{registered.push(tool);return ()=>{released++}}}}}
 const f=await loadModule('my-agent-minecraft',{bootstrapAgent:agent})
 try{
  assert.ok(registered.length>0)
  assert.equal((await registered.find(t=>t.name.endsWith('__get_state')).execute({},f.exec)).ok,true)
 }finally{await f.dispose()}
 assert.equal(released,registered.length)
})

test('actual bootstrap registration goes through host wrapper and stale native tool is rejected after unload',async()=>{
 const h=await kernelFixture('my-agent-minecraft');try{
  const name='mcp__my-agent_minecraft_v2__get_state'
  const old=h.f.ctx.tools.get(name,h.f.agent);assert.ok(old)
  const before=h.loaded.remotes.length;h.mods.stop('my-agent-minecraft')
  await assert.rejects(old.execute({},{agent:h.f.agent,callId:'old-native-bootstrap'}),/stopped or replaced/)
  assert.equal(h.loaded.remotes.length,before)
 }finally{await h.cleanup()}
})

test('self-control synthetic persona restore also runs through actual ToolRuntime and original module kernel',async()=>{
 const h=await kernelFixture('my-agent-self-control');const offs=[]
 try{
  for(const t of h.tools())offs.push(h.f.agent.ctx.tools.register(t))
  const before=h.loaded.persona().body
  const write=await h.f.call('my-agent_persona',{action:'append',body:'SYNTHETIC EXTRA'},'native-persona-change')
  assert.equal(write.value.ok,true);assert.notEqual(h.loaded.persona().body,before)
  const restore=await h.f.call('my-agent_versions',{action:'restore',version_id:write.value.version_id},'native-persona-restore')
  assert.equal(restore.value.ok,true);assert.equal(h.loaded.persona().body,before)
 }finally{for(const off of offs)off();await h.cleanup()}
})

test('original autonomous-desktop callback wakes original native session through real host and stops on rest',async()=>{
 const original=await loadModule('autonomous-desktop');const f=await aurabotHost({builtins:[original.definition]})
 try{
  const future=new Date(Date.now()+86400000);future.setHours(12,0,0,0);original.setNow(future.getTime())
  const run=f.activityCallbacks.find(r=>r.moduleId==='autonomous-desktop').run
  assert.equal((await run()).skipped,'rest');assert.equal(f.requests.length,0)
  await f.supervisor.setRest(false,{op:'wake'});assert.equal((await run()).state,'done')
  assert.equal(f.requests.length,1);assert.equal(f.sent.length,1)
  await f.supervisor.setRest(true,{op:'sleep'});assert.equal((await run()).skipped,'rest');assert.equal(f.requests.length,1)
 }finally{await f.cleanup();await original.dispose()}
})

test('original voice-ear callback consumes synthetic inbox and follows managed original native wake path',async()=>{
 const original=await loadModule('voice-ear');const f=await aurabotHost({builtins:[original.definition]})
 try{
  original.put('C:/Users/test-user/Aurabot/qq-chats/EAR_DIR/inbox.jsonl',JSON.stringify({text:'SYNTHETIC VOICE'})+'\n')
  await f.supervisor.setRest(false,{op:'wake'})
  assert.equal((await f.activityCallbacks.find(r=>r.moduleId==='voice-ear').run()).state,'done')
  assert.equal(f.requests.length,1);assert.equal(f.sent.length,1)
  assert.ok(original.children.length>0)
 }finally{await f.cleanup();await original.dispose()}
})

for(const id of builtinNames)test('upstream builtin '+id+' initializes with synthetic dependencies',async()=>{
 const f=await loadModule(id,{sourceRoot:upstream,entry:'modules/'+id+'/index.js'})
 try{assert.equal(f.definition.id,id);for(const t of f.tools())assert.equal(typeof t.execute,'function')}finally{await f.dispose()}
})

async function combinedHost({mode='reply'}={}){
 const sharedFiles=new Map(),loaded=[]
 let audioFile
 try{
  for(const id of builtinNames)loaded.push(await loadModule(id,{sourceRoot:upstream,entry:'modules/'+id+'/index.js',sharedFiles,...(id==='voice'?{sourceOverrides:candidateVoice}:{}),...(id==='imagegen'?{fetchHandler:async()=>({ok:true,json:async()=>({data:[{b64_json:Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(32)]).toString('base64')}]})})}:{})}))
  const builtin=loaded.slice()
  for(const id of names)loaded.push(await loadModule(id,{sharedFiles}))
  const custom=loaded.slice(builtin.length),memory=builtin.find(f=>f.id==='memory'),persona=builtin.find(f=>f.id==='persona-self')
  const f=await aurabotHost({mode,builtins:builtin.map(v=>v.definition),cosyvoiceSynth:async(text,opt)=>{assert.equal(opt.engine,'cosyvoice');assert.equal(opt.requireRequestedEngine,true);return {file:audioFile,engine:'cosyvoice'}},heartbeat:{legacyDetached:true,readConfig:()=>({enabled:true,intervalSeconds:30,pauseAfterMissed:3,compactBeforeBeat:false,awakeSeconds:0,prompt:'SYNTHETIC COMBINED HEARTBEAT'})},
   configPatch:{voice:{enabled:true,engine:'cosyvoice',cosyvoice:{url:'http://127.0.0.1:50000',mode:'cross_lingual'},autoChance:0},stickers:{enabled:true,autoChance:0,collect:false},imageGen:{enabled:true,apiKey:'SYNTHETIC KEY',baseUrl:'http://synthetic.invalid/v1',model:'synthetic-image'},memory:{enabled:true,dailyNewSession:false},speakUp:{enabled:true,screenPeek:false},diary:{enabled:true},bili:{enabled:true}},
   prepareModules:async({f})=>{
    audioFile=path.join(f.root,'synthetic-combined-voice.wav');writeFileSync(audioFile,buildWav(new Int16Array(500),22050))
    custom.find(v=>v.id==='my-agent-minecraft').put('/synthetic/modules/my-agent-minecraft/connection.json',{runtimeDir:'/synthetic/runtime',stateDir:'/synthetic/runtime',sessionId:f.agent.id,nodeExecutable:'synthetic-node'})
    return {modules:custom.map(v=>({id:v.id,source:readFileSync(new URL(v.id+'/index.mjs',base),'utf8'),setDirectory:v.setAlias})),
     moduleLib:key=>{if(key==='core/store.js')return memory.namespace(key);if(key==='persona/personas.js')return persona.namespace(key);throw Error('unmocked combined module lib')},
     importModule:async url=>{const id=decodeURIComponent(new URL(url).pathname).split('/modules/')[1]?.split('/')[0];const target=custom.find(v=>v.id===id);if(!target)throw Error('unbound custom module');return {default:target.definition}}}
   }})
  return {f,loaded,cleanup:async()=>{await f.cleanup();for(const v of loaded.reverse())await v.dispose()}}
 }catch(error){for(const v of loaded.reverse())await v.dispose();throw error}
}

test('all 15 original builtins and 9 custom modules mount together with heartbeat, normal chat and hot reload',async()=>{
 const h=await combinedHost(),{f}=h
 try{
  for(const id of builtinNames)assert.equal(f.handle.modules.running(id),'builtin',id)
  for(const id of names)assert.equal(f.handle.modules.running(id),'user',JSON.stringify(f.handle.modules.status().find(m=>m.id===id)))
  assert.equal(f.handle.modules.status().filter(m=>m.running).length,24)
  const protectedHash=f.replica.replicaHead(f.local).protected_hash
  await f.emit(f.event(11001,'麦克风 我喜欢合成蓝色风铃'));await f.settle()
  assert.equal(f.sent.length,1);assert.equal(f.replica.replicaHead(f.local).protected_hash,protectedHash)
  await f.supervisor.setRest(false,{op:'combined-wake'});await f.handle.heartbeat.tick();assert.equal(f.sent.length,1)
  await f.handle.modules.reload('my-agent-minecraft');assert.equal(f.handle.modules.running('my-agent-minecraft'),'user')
  await f.emit(f.event(11002,'SYNTHETIC NORMAL CHAT'));await f.settle(2);assert.equal(f.sent.length,2)
  const toolNames=f.handle.modules.buildTools({chat:{kind:'private',userId:'20001',chatId:'private:20001'},level:'full',sessionId:f.agent.id}).map(t=>t.name)
  for(const name of ['remember','recall_memory','qq_chat_history','my-agent_persona','my-agent_room3d','mcp__my-agent_minecraft_v2__get_state'])assert.ok(toolNames.includes(name),name)
  assert.equal(new Set(toolNames).size,toolNames.length)
 }finally{await h.cleanup()}
})

test('media still cannot bypass actual host invocation just because all modules are loaded',async()=>{
 const h=await combinedHost();try{
  await assert.rejects(h.f.handle.hub.sendSegments('private:20001',[{type:'image',data:{file:'base64://SYNTHETIC'}}],'SYNTHETIC IMAGE'),/unbound direct send/)
  assert.equal(h.f.sent.length,0)
 }finally{await h.cleanup()}
})

test('24-module combination executes original qq_send_message with CosyVoice record and one final text reply',async()=>{
 const h=await combinedHost({mode:'voice-tool'});try{
  await h.f.emit(h.f.event(14001,'SYNTHETIC VOICE TOOL'));await h.f.settle(2)
  assert.equal(h.f.sent.length,2);assert.equal(h.f.sent[0].params.message[0].type,'record')
  assert.equal(h.f.sent[1].params.message[0].type,'text')
  await h.f.emit(h.f.event(14001,'SYNTHETIC VOICE TOOL'));assert.equal(h.f.sent.length,2)
 }finally{await h.cleanup()}
})

test('candidate original CosyVoice zero_shot preserves reference fields and wraps PCM; failure never starts Windows fallback',async()=>{
 const requests=[],pcm=Buffer.alloc(1000)
 const f=await loadModule('voice',{sourceRoot:upstream,entry:'modules/voice/index.js',sourceOverrides:candidateVoice,fetchHandler:async(url,init)=>{requests.push({url,init});return {ok:true,arrayBuffer:async()=>pcm.buffer.slice(pcm.byteOffset,pcm.byteOffset+pcm.byteLength)}}})
 try{
  const reference=buildWav(new Int16Array(500),24000);f.put('/synthetic/reference.wav',reference)
  const result=await f.namespace('voice/tts.js').textToSpeech('SYNTHETIC',{engine:'cosyvoice',requireRequestedEngine:true,cosyvoice:{url:'http://127.0.0.1:50000',mode:'zero_shot',refAudio:'/synthetic/reference.wav',promptText:'SYNTHETIC REFERENCE',speed:'1.1',sampleRate:24000}})
  assert.equal(result.engine,'cosyvoice');assert.equal(requests[0].url,'http://127.0.0.1:50000/inference_zero_shot')
  const body=requests[0].init.body;assert.equal(body.get('prompt_text'),'SYNTHETIC REFERENCE');assert.equal(body.get('speed'),'1.1');assert.deepEqual(Buffer.from(await body.get('prompt_wav').arrayBuffer()),reference)
  assert.equal(f.fs.readFileSync(result.file).readUInt32LE(24),24000);assert.equal(f.children.length,0)
 }finally{await f.dispose()}
 const failed=await loadModule('voice',{sourceRoot:upstream,entry:'modules/voice/index.js',sourceOverrides:candidateVoice,fetchHandler:async()=>({ok:false,status:503,text:async()=> 'SYNTHETIC GPU PAUSED'})})
 try{
  failed.put('/synthetic/reference.wav',buildWav(new Int16Array(500),22050))
  await assert.rejects(failed.namespace('voice/tts.js').textToSpeech('SYNTHETIC',{engine:'cosyvoice',requireRequestedEngine:true,cosyvoice:{url:'http://127.0.0.1:50000',mode:'cross_lingual',refAudio:'/synthetic/reference.wav'}}),/no substitute engine/)
  assert.equal(failed.children.length,0)
 }finally{await failed.dispose()}
})

test('24-module combination executes original imagegen tool into durable media outbox without duplicate image',async()=>{
 const h=await combinedHost({mode:'image-tool'});try{
  await h.f.emit(h.f.event(14002,'SYNTHETIC IMAGE TOOL'));await h.f.settle(2)
  assert.equal(h.f.sent.length,2);assert.equal(h.f.sent[0].params.message[0].type,'image');assert.equal(h.f.sent[1].params.message[0].type,'text')
  await h.f.emit(h.f.event(14002,'SYNTHETIC IMAGE TOOL'));assert.equal(h.f.sent.length,2)
 }finally{await h.cleanup()}
})
