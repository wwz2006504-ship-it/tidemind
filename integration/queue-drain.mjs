// Tracks asynchronous dispatch, including work removed from the pending merge map.
// A completed dispatch is not proof that an agent turn or QQ send has finished.
export function createQueueDrain({pending,flush,isBusy,disposed}) {
 const active=new Set();let failures=0
 function track(fn){
  const promise=Promise.resolve().then(fn);active.add(promise)
  promise.then(()=>active.delete(promise),()=>{active.delete(promise);failures++})
  return promise
 }
 const status=()=>({pending:pending.size,active:active.size,busy:isBusy(),failures,disposed:disposed()})
 async function drain({timeoutMs=30000,signal}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('bounded queue drain timeout required')
  const until=performance.now()+timeoutMs
  for(;;){
   signal?.throwIfAborted();const s=status()
   if(s.disposed||s.failures)throw Error('queue dispatch uncertain or disposed; pause retained')
   if(!s.pending&&!s.active&&!s.busy)return s
   if(performance.now()>=until)throw Error('queue drain timed out; pause retained')
   // Do not repeatedly launch a flush while its asynchronous prompt build is active.
   if(!s.active)for(const id of [...pending.keys()])flush(id).catch(()=>{})
   await new Promise(resolve=>setTimeout(resolve,5))
  }
 }
 return {track,status,drain,markFailure:()=>{failures++}}
}
