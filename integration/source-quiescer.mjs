// Candidate orchestration only. Every original subsystem must supply an honest probe.
// This does not acquire/release leases, switch homes, or send/replay messages.
export function createSourceQuiescer({sourceAdmission,memoryBarrier,compositeHead,steps,verifyQuiet,exportTasks}){
 if(exportTasks!==undefined&&typeof exportTasks!=='function')throw Error('task export must be a function when provided')
 const required=['tasks','hub','agents','sessions','memory','outbound','modules']
 if(!required.every(k=>typeof steps?.[k]==='function')||typeof verifyQuiet!=='function'||typeof compositeHead!=='function')throw Error('all original subsystem drain adapters and final verifier required')
 let running=false,outstanding=0
 async function runPreparation(op,{timeoutMs=30000,signal,dryRun=false}={},drainOnly=false){
  if(typeof op!=='string'||!op||op.length>160||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('bounded quiesce operation required')
  if(dryRun)return {dryRun:true,order:['pause','callbacks',...required,'verify',...(exportTasks&&!drainOnly?['export-tasks']:[]),...(drainOnly?[]:['freeze','seal'])],changesAuthority:false}
  if(running||outstanding)throw Error('source quiesce already running or adapter outcome unresolved')
  running=true;const end=performance.now()+timeoutMs,controller=new AbortController()
  const forward=()=>controller.abort(signal.reason);signal?.addEventListener('abort',forward,{once:true})
  let timer
  const stopped=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(controller.signal.reason||Error('source quiesce cancelled')),{once:true})})
  const check=s=>{signal?.throwIfAborted();controller.signal.throwIfAborted();if(s.state!=='paused'||s.op!==op||s.uncertain||s.expired||s.pending||s.clientFailures||s.clientActive||s.durableActive)throw Error('source pause changed or deferred input requires recovery');if(performance.now()>=end)throw Error('source quiesce timed out; pause retained')}
  try{
   signal?.throwIfAborted()
   timer=setTimeout(()=>controller.abort(Error('source quiesce timed out; pause retained')),timeoutMs)
   const run=fn=>{outstanding++;const work=Promise.resolve().then(()=>fn({signal:controller.signal,timeoutMs:Math.max(1,Math.ceil(end-performance.now()))}));work.then(()=>outstanding--,()=>outstanding--);return Promise.race([work,stopped])}
   await run(()=>sourceAdmission.pause(op))
   await run(options=>sourceAdmission.drain(options));check(await run(()=>sourceAdmission.status()))
   for(const name of required){await run(steps[name]);check(await run(()=>sourceAdmission.status()))}
   const proof=await run(verifyQuiet);check(await run(()=>sourceAdmission.status()))
   if(drainOnly){if(proof?.drained!==true)throw Error('subsystem drain not confirmed; pause retained: '+(proof?.blockers||[]).join(', '));return {op,drained:true,sealed:false,changesAuthority:false,proof}}
   if(proof?.quiet!==true)throw Error('final subsystem proof is not quiet; pause retained')
   // Task continuation state is read while everything is already drained and before the memory fence.
   // Any failure here keeps the pause and never freezes, so a handoff cannot proceed without its tasks.
   const taskBundle=exportTasks?await run(exportTasks):undefined
   if(exportTasks&&(taskBundle===null||typeof taskBundle!=='object'||typeof taskBundle.digest!=='string'))throw Error('task export returned no verifiable bundle; pause retained')
   check(await run(()=>sourceAdmission.status()))
   // No await between the last check and the synchronous four-store fence.
   memoryBarrier.begin(op);const seal=memoryBarrier.seal(op,compositeHead)
   return {op,sealed:true,seal,changesAuthority:false,...(taskBundle?{taskBundle}:{})}
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',forward);running=false}
 }
 return Object.freeze({prepare:(op,options)=>runPreparation(op,options),drain:(op,options)=>runPreparation(op,options,true)})
}
