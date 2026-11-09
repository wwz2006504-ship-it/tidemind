// Dedicated REAL DSH session; existing host tools remain available by default. No new grants are minted here.
import {randomUUID} from 'node:crypto'
import {createModelHelpPolicy} from './model-help.mjs'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
// Wait (bounded) for the dedicated session to become free instead of failing the very first step; give up with a RETRYABLE error.
export async function waitForFree({busy,timeoutMs=90_000,pollMs=250,signal}){
 const end=Date.now()+timeoutMs
 while(busy()){
  signal?.throwIfAborted()
  if(Date.now()>=end){const error=Error('cognitive session busy');error.code='TIDEMIND_BUSY';error.retryable=true;throw error}
  await new Promise(r=>setTimeout(r,Math.min(pollMs,Math.max(1,end-Date.now()))))
 }
}
export async function createCognitiveDriver({ctx,controller,sessionId,cwd,ownedRoot,maxTokens=128,busyWaitMs=90_000,toolPolicy='existing',agentPreset,modelHelp}){
 if(typeof sessionId!=='string'||!sessionId.startsWith('tidemind-cognitive-'))throw Error('dedicated cognitive session identity required')
 checkedPath(cwd,ownedRoot)
 if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>512)throw Error('bounded output tokens required')
 let resolved=await controller.resolveAgent(sessionId)
 if(resolved.error){if(resolved.error.code!=='session/not-found')throw resolved.error;const created=await controller.create({sessionId,cwd,...(agentPreset?{agentPreset}:{})});resolved=await controller.resolveAgent(created.sessionId)}
 if(resolved.error)throw resolved.error
 const agent=resolved.agent
 if(!['existing','read-only'].includes(toolPolicy))throw Error('unknown cognitive tool policy')
 if(toolPolicy==='read-only')agent.ctx.tools.restrict({allow:[]})
 const selectModel=createModelHelpPolicy(modelHelp)
 let active,disposed=false,ordinaryRoute,lastHelpRoute
 const routeOf=config=>({provider:config.provider,model:config.model,...(config.reasoningEffort===undefined?{}:{reasoningEffort:config.reasoningEffort})})
 const offRequest=agent.ctx.on('agent/request',async(event,next)=>{
  if(!active)throw Error('unowned cognitive request')
  active.context.guard();if(active.calls>=active.context.maxUnits)throw Error('reserved model request budget exhausted')
  active.calls++;const config=await next();active.context.guard();const decision=active.decision
  let route
  if(decision.kind==='help'){
   if(!lastHelpRoute||config.provider!==lastHelpRoute.provider||config.model!==lastHelpRoute.model)ordinaryRoute=routeOf(config)
   if(!ordinaryRoute)throw Error('ordinary model route unavailable before help')
   route=decision.route;lastHelpRoute=route
  }else{
   if(lastHelpRoute&&config.provider===lastHelpRoute.provider&&config.model===lastHelpRoute.model)route=ordinaryRoute
   else route=routeOf(config)
   ordinaryRoute=route;lastHelpRoute=undefined
  }
  await active.context.recordModelRequest?.({kind:decision.kind,reason:decision.reason,request:active.calls})
  const {provider,model,reasoningEffort,...controls}=config
  return {...controls,...route,maxTokens:Math.min(maxTokens,decision.maxTokens??maxTokens)}
 },{prepend:true})
 async function handle(context){
  if(disposed)throw Error('cognitive driver disposed')
  context.guard()
  await waitForFree({busy:()=>disposed||active||agent.status!=='idle'||agent.inbox?.hasPending,timeoutMs:busyWaitMs,signal:context.signal})
  if(disposed)throw Error('cognitive driver disposed')
  context.guard();if(active||agent.status!=='idle'||agent.inbox?.hasPending)throw Error('cognitive session busy')
  const before=agent.session.snapshotEvents().length
  active={context,calls:0,decision:selectModel(context)}
  const aborted=()=>agent.cancel({kind:'user'})
  context.signal.addEventListener('abort',aborted,{once:true})
  try{
   context.signal.throwIfAborted()
   agent.followup({id:'cognitive-'+randomUUID(),role:'user',content:[{type:'text',text:JSON.stringify({task:context.id,phase:context.phase,input:context.input,previous:context.previous})}],source:{kind:'aurabot'}})
   // Wait for actual session events, not a guessed delay or current status alone.
   await new Promise(resolve=>{
    const check=()=>{if(agent.status==='idle'&&agent.session.snapshotEvents().slice(before).some(e=>e.type==='turn/end')){off();offStatus();resolve()}}
    const off=ctx.on('session/event',session=>{if(session===agent.session)queueMicrotask(check)})
    const offStatus=ctx.on('agent/status',({agent:subject})=>{if(subject===agent)queueMicrotask(check)})
    check()
   })
   await ctx.sessions.flush(agent.session)
   context.signal.throwIfAborted();context.guard()
   const events=agent.session.snapshotEvents().slice(before),end=events.findLast(e=>e.type==='turn/end')
   if(end?.data?.reason?.kind!=='completed')throw Error('cognitive turn did not complete')
   const text=events.findLast(e=>e.type==='assistant/message')?.data?.message?.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n')
   if(typeof text!=='string')throw Error('missing cognitive output')
   return text
  }finally{context.signal.removeEventListener('abort',aborted);active=undefined}
 }
 return {agent,handle,dispose:()=>{if(disposed)return;if(active)throw Error('cognitive driver still active; drain supervisor before disposal');disposed=true;offRequest()}}
}
