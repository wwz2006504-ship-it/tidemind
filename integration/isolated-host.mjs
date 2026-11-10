// REAL installed Cordis, DSH ToolRuntime, SystemPrompt and scope routing.
// Synthetic sessions/events; no model request, desktop profile or QQ startup.
import {pathToFileURL} from 'node:url'
import {fixture} from './fixture.mjs'
import * as fenced from './fenced-store.mjs'
const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
const load=name=>import(pathToFileURL(base+'/'+name+'/lib/index.js').href)
export async function host(seed){
 const f=await fixture(seed)
 const [{Context},{SystemPrompt},{ToolRuntime},scope,plugin]=await Promise.all([
  load('cordis'),load('dsh-system-prompt'),load('dsh-tools'),load('dsh-scope'),import('../host/plugin/src/index.js')])
 const ctx=new Context(),prompt=new SystemPrompt(ctx,{personaPrefix:'SYNTHETIC DEPLOYMENT PERSONA',includeHarnessIdentity:false})
 const tools=new ToolRuntime(ctx,{mode:'native'})
 const sessionId='session-synthetic-my-agent',agent={id:sessionId,turn:0}
 const events=[];agent.session={id:sessionId,header:{origin:'user'},snapshotEvents:()=>events}
 const scoped=scope.createScope(ctx,agent);agent.ctx=scoped.ctx
 fenced.configure({...f,bindings:[{agentId:sessionId,sessionId,logicalAgentId:'my-agent'}]})
 plugin.apply(ctx,{dir:f.localDir,enabled:true,injectContext:true,autoCapture:true,autoCaptureMinConfidence:.75,
   tideEnabled:true,dailyBackup:false,logRetrieval:false,injectTokenBudget:2000})
 await fenced.drain()
 await ctx.parallel(scope.scopeTarget(agent,agent),'agent/created',{agent})
 const claim=async(text,turn=1)=>{
  agent.turn=turn;events.push({type:'turn/start',data:{turn}},{type:'user/message',data:{role:'user',source:{kind:'user'},content:text}})
  await ctx.parallel(scope.scopeTarget(agent,agent),'agent/inbox/claimed',{turn,message:{role:'user',source:{kind:'user'},content:text}})
 }
 const stop=async()=>{await ctx.parallel(scope.scopeTarget(agent,agent),'agent/turn-stopping',{turn:agent.turn});await fenced.drain()}
 const call=(name,args,callId='synthetic-call-'+Date.now(),who=agent)=>tools.execute({name,arguments:args,callId,agent:who,signal:new AbortController().signal})
 const context=async(who=agent)=>{const assembled=await prompt.assemble({scope:who,agent:who});return {assembled,text:assembled.contexts.map(c=>c.text).join('\n')}}
 const cleanup=async()=>{await fenced.drain();await scoped.dispose();await Promise.resolve(ctx.fiber.dispose());if(ctx.fiber.inertia)await ctx.fiber.inertia;f.cleanup()}
 return {...f,ctx,prompt,tools,agent,claim,stop,call,context,cleanup,tick:fenced.tickTide,scope}
}
