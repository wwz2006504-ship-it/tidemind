// Isolated probe mounting ORIGINAL module definitions in the actual tool runtime.
// Not a production startup entry. All auxiliary files are private to the probe.
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import memoryModule from '../host/aurabot/src/modules/memory/index.js'
import personaModule from '../host/aurabot/src/modules/persona-self/index.js'
import {bindReadonlyIdentity} from '../host/aurabot/src/persona/personas.js'
import {buildTools} from '../host/ai-memory/src/tools.js'
import {wrapRemoteOperationTool} from './remote-operation-scope.mjs'
export function mountRemoteSidecarTools(host,remote){
 const prior=process.env.TIDEMIND_AURABOT_DATA_ROOT,data=join(host.root,'probe-aurabot');mkdirSync(data,{recursive:true});process.env.TIDEMIND_AURABOT_DATA_ROOT=data
 const unbind=bindReadonlyIdentity(remote.persona),disposers=[],builders=[]
 const api={config:()=>({persona:{current:'synthetic',selfEditPerDay:10},memory:{enabled:true,recallCount:6}}),core:{protectedMemory:remote.json,hub:{},http:{}},context:()=>{},every:()=>{},route:()=>{},tool:builder=>builders.push(builder),log:()=>{}}
 try{
  memoryModule.setup(api);personaModule.setup(api)
  const chat={kind:'private',chatId:'private:20001',userId:'20001'}
  const definitions=[...builders.flatMap(build=>build({chat,sessionId:host.agent.id,level:'full'})),...buildTools(remote.aiMemory.operations)]
  for(const tool of definitions)disposers.push(host.ctx.tools.register(wrapRemoteOperationTool(tool)))
 }catch(error){for(const dispose of disposers)dispose();unbind();if(prior===undefined)delete process.env.TIDEMIND_AURABOT_DATA_ROOT;else process.env.TIDEMIND_AURABOT_DATA_ROOT=prior;throw error}
 return ()=>{for(const dispose of disposers)dispose();unbind();if(prior===undefined)delete process.env.TIDEMIND_AURABOT_DATA_ROOT;else process.env.TIDEMIND_AURABOT_DATA_ROOT=prior}
}
