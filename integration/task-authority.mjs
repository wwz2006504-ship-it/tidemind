// Original scheduler remains on the authoritative execution host; no remote code injection.
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import {randomUUID} from 'node:crypto'
import {runCognitiveScope} from './activity-gate.mjs'
export function createTaskAuthority({lease,config}){
 const instances=new Map(),activities=new Map(),phases=new Map()
 function phaseHandler(holder,term,phase){return context=>{
  const id='phase:'+randomUUID(),token=randomUUID()
  if(phases.has(id))throw Error('previous original phase outcome requires review')
  let resolve,reject;const work=new Promise((r,j)=>{resolve=r;reject=j})
  phases.set(id,{holder,term,token,context,resolve,reject,claimed:false,finished:false,result:null,kind:'phase'})
  return work
 }}
 function current(holder,term){
  lease.fenced(holder,term,()=>{})
  const key=holder+':'+term
  if(!instances.has(key)){
   for(const instance of instances.values())instance.close().catch(()=>{})
   instances.clear();instances.set(key,createTaskCheckpoints({...config,...(config.execution==='remote-client'?{handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,phaseHandler(holder,term,p)]))}:{}),lease,holder,term}))
  }
  return instances.get(key)
 }
 function activity(holder,term,proof){
  if(!proof||typeof proof.id!=='string'||typeof proof.token!=='string')throw Error('original activity claim required')
  current(holder,term)
  const entry=activities.get(proof.id)||phases.get(proof.id)
  if(!entry||entry.holder!==holder||entry.term!==term||entry.token!==proof.token)throw Error('remote activity claim differs')
  return entry
 }
 async function begin(holder,term,task){
  const scheduler=current(holder,term)
  if(!task||typeof task.id!=='string')throw Error('original bounded activity required')
  // A lost begin reply must not hand the same running callback to another client.
  if(activities.has(task.id)){if(activities.get(task.id).result)return scheduler.runActivity(task,()=>{throw Error('completed original activity cannot restart')});throw Error('remote activity already claimed; review outcome')}
  let ready,resolve,reject
  const started=new Promise(r=>ready=r),completion=new Promise((r,j)=>{resolve=r;reject=j})
  completion.catch(()=>{})
  const entry={holder,term,token:randomUUID(),context:null,result:null,resolve,reject,finished:false}
  activities.set(task.id,entry)
  entry.work=scheduler.runActivity(task,context=>{entry.context=context;ready({id:task.id,token:entry.token,active:true,checkValidForMs:1000});return completion})
  entry.work.then(result=>{entry.result=result;if(!entry.context)activities.delete(task.id);ready(result)},error=>{entry.result={state:'needs_review'};ready(Promise.reject(error))})
  return started
 }
 return {async request(holder,path,body){
  const task=current(holder,body.term)
  if(path==='/task/protocol')return {protocol:'original-task-client-v1',phases:config.execution==='remote-client',toolPolicy:config.toolPolicy||'existing'}
  if(path==='/task/phase/next'){
   if(config.execution!=='remote-client')throw Error('original client phase execution not configured')
   const status=task.status();if(status.control.rest)return {active:false,rest:true}
   for(const [id,entry]of phases){
    if(entry.holder!==holder||entry.term!==body.term||entry.claimed||entry.finished)continue
    entry.context.guard();entry.claimed=true
    const {input,previous,phase,maxUnits}=entry.context
    return {active:true,id,token:entry.token,checkValidForMs:1000,phase:{id:entry.context.id,input,previous,phase,maxUnits}}
   }
   return {active:false,waiting:true}
  }
  if(path==='/task/phase/model-request'){
   const entry=activity(holder,body.term,body.activity)
   if(entry.kind!=='phase'||!entry.claimed||entry.finished)throw Error('actual original cognitive phase required')
   entry.context.guard();entry.context.recordModelRequest(body.decision);return {recorded:true}
  }
  if(path==='/task/phase/finish'){
   const entry=activity(holder,body.term,body.activity)
   if(entry.kind!=='phase'||!entry.claimed||typeof body.success!=='boolean'||body.success&&(typeof body.value!=='string'||body.value.length>4096))throw Error('bounded original phase result required')
   if(entry.finished){if(entry.success!==body.success||entry.value!==body.value)throw Error('phase completion conflict');return {state:entry.result}}
   entry.finished=true;entry.success=body.success;entry.value=body.value
   if(body.success){try{entry.context.guard();entry.resolve(body.value)}catch{entry.result='needs_review';entry.reject(Error('original phase stopped before result'))}}
   else{entry.result='needs_review';entry.reject(Error('client phase cleanup reported failure'))}
   // Allow the original drain/checkpoint chain to commit before reporting completion.
   await new Promise(resolve=>setImmediate(resolve))
   if(!entry.result){const row=task.status().tasks.find(t=>t.id===entry.context.id),index=['observe','reflect','plan','verify'].indexOf(entry.context.phase);entry.result=row?.phase>=index+1?'done':'needs_review'}
   return {state:entry.result}
  }
  if(path==='/task/activity/begin')return begin(holder,body.term,body.task)
  if(path==='/task/activity/check'){
   const entry=activity(holder,body.term,body.activity)
   if(entry.result)return {active:false,state:entry.kind==='phase'?entry.result:entry.result.state}
   try{entry.context?.guard();if(!entry.context)throw Error('claim not started');return {active:true,checkValidForMs:1000}}
   catch{return {active:false,state:'stopping'}}
  }
  if(path==='/task/activity/finish'){
   const entry=activity(holder,body.term,body.activity)
   if(typeof body.success!=='boolean')throw Error('explicit callback cleanup result required')
   if(entry.finished&&entry.success!==body.success)throw Error('callback outcome conflict')
   if(!entry.finished){entry.finished=true;entry.success=body.success;if(body.success)entry.resolve();else entry.reject(Error('remote callback requires review'))}
   return entry.work
  }
  if(path==='/task/enqueue')return task.enqueue(body.task,{dryRun:body.dryRun===true})
  if(path==='/task/rest')return task.setRest(body.rest,{op:body.op,dryRun:body.dryRun===true})
  if(path==='/task/rest-request'){const {completion,...receipt}=task.requestRest(body.rest,{op:body.op,dryRun:body.dryRun===true});completion.catch(()=>{});return receipt}
  if(path==='/task/status')return task.status()
  if(path==='/task/trace')return task.trace(body.id,{after:body.after??0,limit:body.limit??100})
  throw Error('unknown original task operation')
 },withActivity(holder,term,proof,fn){const entry=activity(holder,term,proof);if(!entry.context||entry.finished||entry.result)throw Error('remote callback ended');entry.context.guard();return runCognitiveScope(entry.context.guard,fn,{toolPolicy:config.toolPolicy||'existing',signal:entry.context.signal})},async close(){for(const entry of [...activities.values(),...phases.values()])if(!entry.finished){entry.finished=true;entry.success=false;const error=Error('authority closing with unconfirmed client cleanup');error.code='TIDEMIND_OUTCOME_UNKNOWN';entry.reject(error)}await Promise.allSettled([...instances.values()].map(x=>x.close()))}}
}
