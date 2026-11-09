// Preserve actual per-session event order across asynchronous authority calls.
export function createSessionEventQueue({handler,onError=()=>{}}){
 if(typeof handler!=='function')throw Error('original session event handler required')
 const tails=new Map(),pending=new Set(),failed=new Set();let failures=0,closed=false
 function run(session,event){
  if(closed)return Promise.reject(Error('session event queue closed'))
  const id=session?.id;if(typeof id!=='string'||!id)return Promise.reject(Error('actual session identity required'))
  const previous=tails.get(id)||Promise.resolve()
  const work=previous.then(()=>{if(failed.has(id))throw Error('prior session event requires review');return handler(session,event)})
  tails.set(id,work);pending.add(work)
  work.then(()=>{pending.delete(work);if(tails.get(id)===work)tails.delete(id)},error=>{pending.delete(work);if(!failed.has(id)){failed.add(id);failures++;onError(error)}})
  return work
 }
 const status=()=>({active:pending.size,failures,failedSessions:failed.size,closed})
 async function drain({timeoutMs=30000,signal}={}){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('bounded session event drain required');const end=performance.now()+timeoutMs;while(pending.size){signal?.throwIfAborted();if(performance.now()>=end)throw Error('session event drain timed out');await new Promise(r=>setTimeout(r,5))}if(failures)throw Error('session event outcome requires review');return status()}
 return {run,status,drain,close:async options=>{closed=true;return drain(options)}}
}
