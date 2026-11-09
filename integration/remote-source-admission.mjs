// Whole trusted client callback admission counted in the ORIGINAL source gate.
import {AsyncLocalStorage} from 'node:async_hooks'
import {sourceEventHash} from './source-admission.mjs'
export function createRemoteSourceAdmission({authority,term}){
 const context=new AsyncLocalStorage(),active=new Set();let failures=0
 const request=(path,body={})=>authority.request(path,{...body,term:typeof term==='function'?term():term})
 async function runDispatch(event,fn){
  if(typeof fn!=='function')throw Error('actual original dispatch callback required')
  const eventHash=sourceEventHash(event),op='callback:'+eventHash,entry=await request('/qq/source/begin',{op,event})
  if(!entry.admitted){if(entry.state==='active'||entry.state==='review')throw Error('source callback outcome requires review');return entry}
  const scope={op,eventHash,active:true},work=(async()=>{
   let result
   try{result=await context.run(scope,fn)}catch(error){await request('/qq/source/finish',{op,eventHash,success:false}).catch(()=>{});throw error}
   try{await request('/qq/source/finish',{op,eventHash,success:true})}catch(error){const saved=await request('/qq/source/callback',{op}).catch(()=>null);if(saved?.state!=='done'||saved.event_hash!==eventHash)throw error}
   return result
  })()
  try{return await work}finally{scope.active=false}
 }
 function dispatch(event,fn){const work=runDispatch(event,fn);active.add(work);work.then(()=>active.delete(work),()=>{active.delete(work);failures++});return work}
 function replay(op,originalDispatch,{limit=32}={}){
  const work=(async()=>{if(typeof originalDispatch!=='function'||!Number.isSafeInteger(limit)||limit<1||limit>64)throw Error('bounded original deferred replay required');let forwarded=0
   for(let i=0;i<limit;i++){
    const {event}=await request('/qq/source/replay-claim',{op});if(!event)break
    if(sourceEventHash(event.raw)!==event.id||event.callbackOp!=='replay:'+event.id)throw Error('original deferred event changed')
    const scope={op:event.callbackOp,eventHash:event.id,active:true}
    try{try{await context.run(scope,()=>originalDispatch(event.raw))}catch(error){await request('/qq/source/replay-finish',{op,id:event.id,success:false}).catch(()=>{});throw error}
     try{await request('/qq/source/replay-finish',{op,id:event.id,success:true})}catch(error){const row=await request('/qq/source/callback',{op:event.callbackOp}).catch(()=>null);if(row?.state!=='done'||row.event_hash!==event.id)throw error}
     forwarded++
    }finally{scope.active=false}
   }
   return {forwarded,...await status()}
  })();active.add(work);work.then(()=>active.delete(work),()=>{active.delete(work);failures++});return work
 }
 async function status(){const state=await request('/qq/source/status');return {...state,clientActive:active.size,clientFailures:failures}}
 async function drain({timeoutMs=30000,signal}={}){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('bounded source drain required');const end=performance.now()+timeoutMs;while(active.size){signal?.throwIfAborted();if(performance.now()>=end)throw Error('client source callback drain timed out');await new Promise(r=>setTimeout(r,5))}const state=await status();if(failures||state.durableActive||state.uncertain)throw Error('source callback outcome unresolved');return state}
 return Object.freeze({dispatch,status,drain,replay,pause:op=>request('/qq/source/pause',{op}),resume:op=>request('/qq/source/resume',{op}),currentCallback:()=>{const scope=context.getStore();if(scope&&!scope.active)throw Error('source callback ended');return scope?{op:scope.op,eventHash:scope.eventHash}:null}})
}
