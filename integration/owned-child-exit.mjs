// Join the exact ChildProcess handle the module spawned. This proves only that
// process exited, not that arbitrary descendants or external peripherals stopped.
import {ChildProcess} from 'node:child_process'
const stopping=new WeakMap()
export function stopOwnedChild(child,{timeoutMs=5000}={}){
 if(child===null||child===undefined)return Promise.resolve({exited:true,absent:true})
 if(!(child instanceof ChildProcess))throw Error('actual owned ChildProcess handle required')
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('bounded child exit timeout required')
 if(stopping.has(child))return stopping.get(child)
 const work=new Promise((resolve,reject)=>{
  let timer
  const cleanup=()=>{clearTimeout(timer);child.off('exit',exit);child.off('error',error)}
  const exit=(code,signal)=>{cleanup();resolve({exited:true,code,signal})}
  const error=cause=>{cleanup();reject(cause)}
  if(child.exitCode!==null||child.signalCode!==null)return exit(child.exitCode,child.signalCode)
  child.once('exit',exit);child.once('error',error)
  timer=setTimeout(()=>error(Error('owned child exit unconfirmed; retain transfer block')),timeoutMs)
  try{child.kill()}catch(cause){error(cause)}
 })
 stopping.set(child,work);return work
}
