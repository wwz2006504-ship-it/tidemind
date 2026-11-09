// Adapter for original module callbacks, using the existing durable task control/budget.
import {randomUUID} from 'node:crypto'
import {AsyncLocalStorage} from 'node:async_hooks'
import {assertCognitiveActive} from './activity-gate.mjs'
export function createModuleActivity({supervisor,capabilities,agent,ctx,assertHostActive=()=>{},unitsPerCallback=1,maxTokens=128,onRegister,resolveActivityAgent,assertActivityAgent=()=>{}}){
 if(typeof supervisor?.runActivity!=='function'||typeof capabilities?.wrapAutonomousTool!=='function'||!agent?.session?.id||agent.id!==agent.session.id)throw Error('bound original agent and existing supervisor required')
 const running=new Set()
 const scope=new AsyncLocalStorage();let activeTurn=null
 const reserveModelRequest=(context=scope.getStore())=>{if(!context)return;context.guard();if(context.calls++>=unitsPerCallback)throw Error('module model request budget exhausted')}
 if(!Number.isSafeInteger(unitsPerCallback)||unitsPerCallback<1||!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>512)throw Error('bounded module activity budget required')
 const watchRequest=()=>ctx?agent.ctx.on('agent/request',async(event,next)=>{
  if(!activeTurn)return next()
  reserveModelRequest(activeTurn)
  const config=await next();activeTurn.guard();return {...config,maxTokens}
 }):null
 let requestOff=watchRequest()
 async function refreshAgent(){
  if(!resolveActivityAgent){assertActivityAgent(agent);return true}
  const next=await resolveActivityAgent()
  if(!next?.session?.id||next.id!==next.session.id)throw Error('current original owner agent required')
  assertActivityAgent(next)
  if(next!==agent){if(running.size||activeTurn)return false;requestOff?.();agent=next;requestOff=watchRequest()}
  return true
 }
 function wrap(fn,{moduleId,label,guard}){
  const run=async()=>{
   assertHostActive();guard()
   if(!await refreshAgent())return {skipped:'session-changing'}
   if(running.has(moduleId)||activeTurn||(agent.status&&agent.status!=='idle')||agent.inbox?.hasPending)return {skipped:'busy'}
   running.add(moduleId)
   const id='module:'+moduleId+':'+randomUUID()
   try{return await supervisor.runActivity({id,input:moduleId+':'+label,units:unitsPerCallback},async context=>{
    const check=()=>{assertHostActive();guard();context.guard();assertActivityAgent(agent)}
    const tool=capabilities.wrapAutonomousTool({execute:()=>scope.run({...context,moduleId,sequence:0,calls:0},()=>fn(context))},{guard:check})
    return tool.execute({},{agent,callId:id,signal:context.signal})
   })}finally{running.delete(moduleId)}
  }
  onRegister?.({moduleId,label,run});return run
 }
 async function wake(hub,[chat,content,senderId,options={}]){
  const context=scope.getStore();if(!context||!ctx||senderId||chat?.kind!=='private')throw Error('managed private module wake required')
  context.guard();assertActivityAgent(agent);if(activeTurn||agent.status!=='idle'||agent.inbox?.hasPending)throw Error('bound original session busy')
  if(hub.sessions?.()[chat.chatId]?.sessionId!==agent.session.id)throw Error('original session mapping changed')
  const receipt=await capabilities.outbound.observeAutonomous({id:context.id+':wake:'+context.sequence++,moduleId:context.moduleId,chatId:chat.chatId,content})
  const before=agent.session.snapshotEvents().length
  const nextTurn=(agent.session.snapshotEvents().findLast(e=>e.type==='turn/start')?.data?.turn??0)+1
  const hubCompletion=hub.watchTurn(agent.session.id,nextTurn)
  activeTurn=context
  const abort=()=>agent.cancel({kind:'user'})
  context.signal.addEventListener('abort',abort,{once:true})
  let off=()=>{},offStatus=()=>{}
  const completed=new Promise(resolve=>{
   const check=()=>{if(agent.status==='idle'&&agent.session.snapshotEvents().slice(before).some(e=>e.type==='turn/end'))resolve()}
   off=ctx.on('session/event',session=>{if(session===agent.session)queueMicrotask(check)})
   offStatus=ctx.on('agent/status',({agent:subject})=>{if(subject===agent)queueMicrotask(check)})
  })
  try{
   context.guard()
   await hub.pushToSession(chat,content,'',{...options,origins:[receipt.origin],sourceOrigin:'module-event'})
   await completed;await hubCompletion.promise;await ctx.sessions.flush(agent.session);await capabilities.outbound.idle();context.guard()
   if(agent.session.snapshotEvents().slice(before).findLast(e=>e.type==='turn/end')?.data?.reason?.kind!=='completed')throw Error('module turn did not complete')
  }finally{hubCompletion.cancel();off();offStatus();context.signal.removeEventListener('abort',abort);activeTurn=null}
 }
 const protect=(target,kind)=>new Proxy({},{ownKeys:()=>Reflect.ownKeys(target),getOwnPropertyDescriptor:(_object,key)=>Object.hasOwn(target,key)?{configurable:true,enumerable:true,value:Reflect.get(target,key),writable:false}:undefined,get(_object,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return (...args)=>{assertHostActive();assertCognitiveActive();if(kind==='hub'&&key==='pushToSession')return wake(target,args);return value.apply(target,args)}}})
 function protectCore(core){const cache=new Map();return new Proxy(core,{get(object,key){if(['hub','local','snowluma','voiceTTS','protectedMemory','tidemind'].includes(key)&&object[key]){if(!cache.has(key))cache.set(key,protect(object[key],key));return cache.get(key)}if(key==='ask')return (...args)=>{assertHostActive();assertCognitiveActive();const context=scope.getStore();reserveModelRequest(context);return context?object.ask({...args[0],maxTokens}):object.ask(...args)};return Reflect.get(object,key)}})}
 return {currentAgent:()=>agent,wrap,protectCore,reserveModelRequest,interruptForUser:async()=>{if(activeTurn)await supervisor.cancelActivity(activeTurn.id)},assertActive:()=>{assertHostActive();assertCognitiveActive()},close:async()=>{try{return await supervisor.setRest(true,{op:'module-host-stop-'+randomUUID()})}finally{requestOff?.()}}}
}
