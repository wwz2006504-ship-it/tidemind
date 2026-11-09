// Original heartbeat runtime, selected agent only; no second scheduler or QQ sender.
import {HeartbeatRuntime} from '../host/heartbeat/runtime.js'
import {assertCognitiveActive} from './activity-gate.mjs'
export function createManagedHeartbeat({activity,agent,hub,chat,readConfig,agents,getCompaction,logger,legacyDetached=false}){
 if(!legacyDetached)throw Error('legacy heartbeat handoff must be confirmed before attaching managed runtime')
 if(typeof activity?.wrap!=='function'||!agent?.session?.id||typeof hub?.pushToSession!=='function'||typeof readConfig!=='function'||chat?.kind!=='private')throw Error('bound heartbeat host context required')
 let disposed=false,started=false
 const guard=()=>{if(disposed)throw Error('heartbeat disposed');assertCognitiveActive()}
 const core=activity.protectCore({hub})
 const runtime=new HeartbeatRuntime(agent,{agents,logger,readConfig,getCompaction:()=>{
  guard();const compaction=getCompaction?.();if(!compaction)return undefined
  return {compactNow:async(...args)=>{guard();activity.reserveModelRequest();const result=await compaction.compactNow(...args);guard();return result}}
 },deliver:async message=>{guard();await core.hub.pushToSession(chat,message.content,'',{suppressFinal:true});guard()}})
 function refreshOwner(){
  const current=activity.currentAgent?.()||agent
  if(current===runtime.agent)return
  // Keep missed-count/hourly budget across daily sessions; remove all old-session listeners/timers.
  runtime.clearTimer();runtime.clearStayTimers();runtime.stopInserted?.();runtime.stopInserted=undefined
  runtime.agent=current
  if(started)runtime.start()
 }
 const tick=runtime.tick.bind(runtime),stay=runtime.stayTick.bind(runtime)
 const managedTick=activity.wrap(async()=>{guard();refreshOwner();return tick()},{moduleId:'dsh-heartbeat',label:'heartbeat',guard})
 runtime.tick=()=>Promise.resolve(managedTick()).finally(()=>runtime.rearm())
 runtime.stayTick=activity.wrap(async()=>{guard();refreshOwner();return stay()},{moduleId:'dsh-heartbeat',label:'stay-awake',guard})
 return {runtime,tick:()=>runtime.tick(),stayTick:()=>runtime.stayTick(),start:()=>{guard();if(started)return;started=true;runtime.start()},dispose:()=>{if(disposed)return;disposed=true;runtime.dispose()}}
}
