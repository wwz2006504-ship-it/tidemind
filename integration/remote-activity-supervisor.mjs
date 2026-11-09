// Client callbacks reserve budget/state in the ORIGINAL scheduler. The local
// guard proves client lifetime/cancellation only; it is never a SQLite/RPC fence.
// All authoritative effects carry the original server-owned activity claim.
import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'
import {runCognitiveScope} from './activity-gate.mjs'
export function createRemoteActivitySupervisor({authority,term,toolPolicy='existing'}){
 if(typeof authority?.request!=='function'||!Number.isSafeInteger(term)||term<1||!['existing','read-only'].includes(toolPolicy))throw Error('actual remote authority, acquired term and tool policy required')
 const scope=new AsyncLocalStorage(),active=new Map();let closing=false,failures=0,closeWork,worker,workerDriver,wakeWorker,workerTimer
 const request=(path,body={})=>authority.request(path,{...body,term})
 const contextualAuthority=Object.freeze({request:(path,body={})=>{
  const entry=scope.getStore();if(!entry)return request(path,body)
  entry.guard();return request(path,{...body,activity:entry.claim})
 }})
 function executeClaim(task,fn,{phase=false}={}){
  if(closing||typeof fn!=='function')return Promise.reject(Error('active remote callback required'))
  if(!task?.id||active.has(task.id))return Promise.reject(Error('unique original activity required'))
  const controller=new AbortController(),entry={controller,claim:null,live:true,freshUntil:0,timer:null,pollTimer:null,pollWake:null,work:null}
  entry.guard=()=>{controller.signal.throwIfAborted();if(!entry.live||closing||performance.now()>=entry.freshUntil)throw Error('client activity ended or fresh authority check unavailable')}
  const abort=()=>controller.abort(Error('remote activity paused, fenced or unavailable'))
  const refresh=value=>{if(value?.active!==true||!Number.isSafeInteger(value.checkValidForMs)||value.checkValidForMs<1||value.checkValidForMs>1000)throw Error('unconfirmed original activity state');entry.freshUntil=performance.now()+value.checkValidForMs;clearTimeout(entry.timer);entry.timer=setTimeout(abort,value.checkValidForMs)}
  const wait=()=>new Promise(resolve=>{entry.pollWake=resolve;entry.pollTimer=setTimeout(resolve,200)})
  entry.work=(async()=>{
   let monitor,success=false,value
   try{
    const grant=await request(phase?'/task/phase/next':'/task/activity/begin',phase?{}:{task})
    if(!grant.active)return grant
    if((phase?typeof grant.id!=='string':grant.id!==task.id)||typeof grant.token!=='string'||!grant.token)throw Error('original callback claim differs')
    if(phase&&(!['observe','reflect','plan','verify'].includes(grant.phase?.phase)||typeof grant.phase.input!=='string'||typeof grant.phase.previous!=='string'||typeof grant.phase.id!=='string'||!Number.isSafeInteger(grant.phase.maxUnits)||grant.phase.maxUnits<1))throw Error('actual original phase descriptor required')
    entry.claim={id:grant.id,token:grant.token};refresh(grant)
    refresh(await request('/task/activity/check',{activity:entry.claim}))
    monitor=(async()=>{while(entry.live&&!controller.signal.aborted){await wait();if(!entry.live||controller.signal.aborted)break;try{refresh(await request('/task/activity/check',{activity:entry.claim}))}catch{abort();break}}})()
    entry.guard()
    value=await scope.run(entry,()=>runCognitiveScope(entry.guard,()=>fn({...(phase?grant.phase:{id:task.id}),signal:controller.signal,guard:entry.guard,...(phase?{recordModelRequest:decision=>{entry.guard();return request('/task/phase/model-request',{activity:entry.claim,decision})}}:{})}),{toolPolicy,signal:controller.signal}))
    entry.guard();success=true
   }catch{if(!entry.claim)failures++}
   finally{entry.live=false;clearTimeout(entry.timer);clearTimeout(entry.pollTimer);entry.pollWake?.();if(monitor)await monitor}
   if(!entry.claim)return {state:'needs_review'}
   try{
    const result=await request(phase?'/task/phase/finish':'/task/activity/finish',{activity:entry.claim,success,...(phase&&success?{value}:{})})
    if(!['done','needs_review'].includes(result?.state))throw Error('original callback completion unconfirmed')
    return {...result,...(result.state==='done'?{value}:{})}
   }catch{
    const saved=await request('/task/activity/check',{activity:entry.claim}).catch(()=>null)
    if(saved?.active===false&&['done','needs_review'].includes(saved.state))return {state:saved.state,...(saved.state==='done'?{value}:{})}
    failures++;return {state:'needs_review'}
   }
  })().finally(()=>active.delete(task.id))
  active.set(task.id,entry);return entry.work
 }
 const idle=async()=>{while(active.size)await Promise.allSettled([...active.values()].map(e=>e.work))}
 async function setRest(rest,options={}){
  if(rest&&!options.dryRun)for(const entry of active.values())entry.controller.abort(Error('rest requested'))
  const own=scope.getStore(),path=rest&&own?'/task/rest-request':'/task/rest'
  const result=await request(path,{rest,op:options.op,dryRun:options.dryRun===true})
  if(typeof result?.rest!=='boolean'||typeof result.drained!=='boolean'||result.rest!==rest)throw Error('original rest confirmation unavailable')
  if(rest&&!own&&!options.dryRun){await idle();if(failures)throw Error('remote callback outcome unresolved')}
  return {...result,drained:result.drained&&active.size===0}
 }
 const runNextPhase=driver=>executeClaim({id:'phase-worker:'+randomUUID()},context=>driver.handle(context),{phase:true})
 async function startPhaseWorker(driver){
  if(closing||typeof driver?.handle!=='function'||!driver.agent?.id?.startsWith('tidemind-cognitive-'))throw Error('actual original cognitive driver required')
  if(worker){if(workerDriver!==driver)throw Error('another phase worker already owns client');return}
  const protocol=await request('/task/protocol')
  if(protocol.protocol!=='original-task-client-v1'||protocol.phases!==true||protocol.toolPolicy!==toolPolicy)throw Error('original client phase protocol unavailable')
  workerDriver=driver
  worker=(async()=>{while(!closing){const result=await runNextPhase(driver);if(closing)break;if(result.state==='needs_review'){const state=await request('/task/status');if(failures||state.tasks.some(t=>t.state==='needs_review')){failures++;break}}if(result.state==='done')continue;await new Promise(resolve=>{wakeWorker=resolve;workerTimer=setTimeout(resolve,1000)})}})()
  worker.catch(()=>{failures++})
 }
 const notifyWorker=()=>{clearTimeout(workerTimer);wakeWorker?.();wakeWorker=null}
 return Object.freeze({authority:contextualAuthority,runActivity:(task,fn)=>executeClaim(task,fn),runNextPhase,startPhaseWorker,idle,setRest:async(...args)=>{const result=await setRest(...args);notifyWorker();return result},
  status:async()=>{const result=await request('/task/status');return {...result,active:Math.max(result.active,active.size),clientActive:active.size,clientFailures:failures}},
  enqueue:async(task,options={})=>{const result=await request('/task/enqueue',{task,dryRun:options.dryRun===true});if(!options.dryRun)notifyWorker();return result},trace:(id,options={})=>request('/task/trace',{id,...options}),
  cancelActivity:async id=>{const entry=active.get(id);if(!entry)return {active:false};entry.controller.abort(Error('module activity interrupted'));await entry.work;return {active:false,drained:true}},
  close:()=>closeWork??=(async()=>{closing=true;notifyWorker();try{await setRest(true,{op:'remote-host-close:'+randomUUID()})}finally{await idle();if(worker)await worker}})(),
 })
}
