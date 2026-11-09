// Preserve synchronous callback behaviour while retaining async work/errors for transfer checks.
export function createCallbackWork(){
 const active=new Set();let failures=0
 function run(fn){
  let value;try{value=fn()}catch(error){failures++;throw error}
  if(value&&typeof value.then==='function'){
   const work=Promise.resolve(value);active.add(work)
   work.then(()=>active.delete(work),()=>{active.delete(work);failures++})
  }
  return value
 }
 const status=()=>({active:active.size,failures})
 async function drain({timeoutMs=30000,signal}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('bounded callback drain required')
  const until=performance.now()+timeoutMs
  for(;;){signal?.throwIfAborted();if(failures)throw Error('module callback outcome requires review');if(!active.size)return status();if(performance.now()>=until)throw Error('module callback drain timed out');await new Promise(r=>setTimeout(r,5))}
 }
 return {run,status,drain}
}
