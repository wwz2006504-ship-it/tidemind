// Real installed controller/loop/persistence. No desktop profile or network provider is loaded.
import {pathToFileURL} from 'node:url'
import {join} from 'node:path'
import {fixture} from './fixture.mjs'
import * as fenced from './fenced-store.mjs'
const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
const load=n=>import(pathToFileURL(base+'/'+n+'/lib/index.js').href)
export async function controllerHost({mode='reply',storageFixture,resumeSessionId,reasoning=false,mountMemory=true,scriptedCalls=[],memoryText='合成工具链已提交 风铃约定'}={}){
 const f=storageFixture||await fixture(raw=>raw.write({layer:'semantic',content:'合成检索标记 麦克风 调试约定',tags:['合成'],source:'tool'},1))
 const [{Context},typert,session,projections,agents,loop,llm,prompt,tools,query,controller,persistence]=await Promise.all(['cordis','dsh-typert-registry','dsh-session','dsh-session-projection','dsh-agent','dsh-agent-loop','dsh-llm','dsh-system-prompt','dsh-tools','dsh-session-query','dsh-api-session-controller','dsh-session-persistence-jsonl'].map(load))
 const ctx=new Context(),errors=[],requests=[]
 try{
 ctx.on('agent/error',({error})=>errors.push(error))
 new typert.TypertRegistry(ctx);new projections.SessionProjectionRegistry(ctx);new session.SessionStore(ctx);new agents.AgentRegistry(ctx)
 new prompt.SystemPrompt(ctx,{personaPrefix:'SYNTHETIC IDENTITY ONLY',includeHarnessIdentity:false});new tools.ToolRuntime(ctx,{mode:'native'});new llm.LlmRuntime(ctx)
 // Peripheral UI/file capabilities are denied test doubles, never local grants.
 ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'synthetic-offline',model:'fixed'})})
 ctx.provide('workspaceRegistry',{archivedSessionIds:[],list:()=>[]})
 ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{}})
 ctx.provide('remoteAccess',{allows:()=>false})
 ctx.provide('attachments',{imageLimits:{maxImageBytes:1,maxImagesPerMessage:1,maxMessageImageBytes:1,maxImagePixels:1,maxImageDimension:1,mediaTypes:[]}})
 ctx.provide('fs',{})
 new query.SessionQueryEngine(ctx)
 await persistence.apply(ctx,{root:join(f.root,'sessions'),compression:'none'})
 class Offline extends llm.LlmAdapter{
 async resolveModel(provider,model,signal){const info=await super.resolveModel(provider,model,signal);return reasoning?{...info,reasoning:{efforts:[{id:'low',name:'Synthetic low'},{id:'high',name:'Synthetic high'}]}}:info}
 async *stream(options){
  options.signal?.throwIfAborted();requests.push(options)
  const step=requests.length
  if(mode==='wait-abort'||(mode==='wait-first-abort'&&step===1))await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})})
  if(mode==='scripted-tools'&&step<=scriptedCalls.length){
   const call=scriptedCalls[step-1];yield {type:'tool-call-delta',index:0,id:call.id,name:call.name,argumentsDelta:JSON.stringify(call.args)}
  }else if(mode==='image-tool'&&step===1){
   yield {type:'tool-call-delta',index:0,id:'synthetic-image-tool',name:'qq_draw_image',argumentsDelta:JSON.stringify({prompt:'SYNTHETIC IMAGE'})}
  }else if(mode==='voice-tool'&&step===1){
   yield {type:'tool-call-delta',index:0,id:'synthetic-voice-tool',name:'qq_send_message',argumentsDelta:JSON.stringify({target:'private:20001',text:'<voice>合成 CosyVoice 声音</voice>'})}
  }else if(mode==='module-group-admin'&&step%2===1){
   yield {type:'tool-call-delta',index:0,id:'synthetic-module-'+step,name:'qq_group_admin',argumentsDelta:JSON.stringify({action:'ban',group_id:'30001',user_id:'20002',minutes:1})}
  }else if(mode==='work-tool'&&step===1){
   yield {type:'tool-call-delta',index:0,id:'synthetic-autonomous-work',name:'work_marker',argumentsDelta:'{}'}
  }else if(mode==='memory-tools'&&step<=2){
   yield {type:'tool-call-delta',index:0,id:'synthetic-tool-'+step,name:step===1?'lmem_search':'lmem_write',argumentsDelta:JSON.stringify(step===1?{query:'麦克风'}:{layer:'semantic',content:memoryText,tags:'合成'})}
  }else if(mode==='core-attempt'&&step===1){
   yield {type:'tool-call-delta',index:0,id:'synthetic-core-attempt',name:'lmem_write',argumentsDelta:JSON.stringify({layer:'core',content:'不允许覆盖身份'})}
  }else yield {type:'text-delta',index:0,text:mode==='voice-reply'?'<voice>合成 CosyVoice 声音</voice>':'合成完整链路回复'}
  yield {type:'finish',reason:{kind:'stop'}}
 }}
 ctx.llm.registerAdapter(['synthetic-offline'],new Offline())
 new loop.AgentLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>1}})
 const control=new controller.SessionController(ctx,{nativeOpen:false,listWorkSliceMs:16})
 const sessionId='session-real-isolated-xiyu'
 fenced.configure({...f,bindings:[{agentId:sessionId,sessionId,logicalAgentId:'xiyu'}]})
 const memory=await import('../host/plugin/src/index.js')
 if(mountMemory)memory.apply(ctx,{dir:f.localDir,enabled:true,injectContext:true,autoCapture:true,autoCaptureMinConfidence:.75,tideEnabled:false,dailyBackup:false,logRetrieval:false,injectTokenBudget:2000})
 await fenced.drain()
 const created=resumeSessionId?{sessionId:resumeSessionId}:await control.create({sessionId,cwd:join(f.root,'workspace')})
 const resolved=await control.resolveAgent(created.sessionId);if(resolved.error)throw resolved.error
 const agent=resolved.agent
 const closeRuntime=async()=>{await fenced.drain();await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia}
 const cleanup=async()=>{await closeRuntime();f.cleanup()}
 return {...f,ctx,controller:control,agent,requests,errors,cleanup,closeRuntime,storageFixture:f}
 }catch(error){await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia;throw error}
}
