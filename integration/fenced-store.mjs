import {assertCognitiveActive} from './activity-gate.mjs'
// Scoped runtime configuration for the isolated copy of the ORIGINAL plugin.
import {AsyncLocalStorage} from 'node:async_hooks'
import {DatabaseSync} from 'node:sqlite'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {executeStoreOperation} from './store-adapter.mjs'
import * as replica from '../TideMind/deploy/existing/tide-replica.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {MemoryStore as Original} from '../host/plugin/src/store.js'
const scope=new AsyncLocalStorage();let runtime
export function configure(value){runtime=value;runtime.timers=new Map();runtime.maintenanceCounter=0;runtime.invalidate=()=>{};runtime.operationCounter=0}
export function useSessionBindings(registry){if(!runtime||!Array.isArray(registry?.bindings)||typeof registry.authorize!=='function')throw Error('configured host session registry required');registry.inspect();runtime.bindings=registry.bindings}
export function allowedAgent(agent){return Boolean(agent&&runtime?.bindings?.some(b=>b.agentId===agent.id&&b.sessionId===agent.session?.id&&b.logicalAgentId==='xiyu'))}
export function bindAgent(agent,meta,fn){
 assertCognitiveActive()
 if(!allowedAgent(agent))throw new Error('agent/session mapping not authorized')
 return scope.run({sessionId:agent.session.id,agentId:agent.id,...meta},fn)
}
export function maintenance(reason,fn){const execute=()=>scope.run({system:true,callId:'maintenance-'+reason+'-'+(++runtime.maintenanceCounter)},fn);return runtime.runMaintenance?runtime.runMaintenance(reason,execute):execute()}
export function setInvalidation(fn){runtime.invalidate=fn}
export function scheduleTide(fn,ms){const token=setInterval(()=>Promise.resolve(fn()).catch(()=>{}),ms);token.unref();runtime.timers.set(token,fn);return token}
export function clearTide(token){clearInterval(token);runtime?.timers.delete(token)}
export async function tickTide(){for(const fn of runtime.timers.values())await fn()}
export async function drain(){if(runtime?.store)await runtime.store.drain()}
export class MemoryStore {
 constructor(dir,options={}){
  const file=replica.checkedPath(join(dir,'memory.db'))
  if(file!==replica.checkedPath(runtime.local))throw new Error('store path not bound to runtime')
  const original=Object.create(Original.prototype)
  Object.assign(original,{dir,dbPath:file,backupDir:join(dir,'backups'),exportDir:join(dir,'exports'),keepBackups:7,
    db:new DatabaseSync(file,{readOnly:true})})
  original.db.exec('PRAGMA query_only=ON')
  let queue=Promise.resolve(),closed=false
  const submit=(method,args)=>{
   const binding=scope.getStore()
   if(!binding||(!binding.system&&!runtime.bindings.some(b=>b.agentId===binding.agentId&&b.sessionId===binding.sessionId)))return Promise.reject(new Error('write binding required'))
   if(closed)return Promise.reject(new Error('store closed'))
   const op=hash({session:binding.sessionId||'system',turn:binding.turn||0,call:binding.callId||randomUUID(),method,args})
   const job=queue.then(async()=>{
    let out
    if(runtime.remoteStoreExecutor)out=await runtime.remoteStoreExecutor.submit({operation:{method,args},op})
    else {const head=runtime.gateway.head(runtime.lease)
     out=await executeStoreOperation({gateway:runtime.gateway,lease:runtime.lease,holder:'local',term:runtime.term,
      srcDbPath:file,operation:{method,args},op,expectedRevision:head.revision,expectedHash:head.hash})}
    if(out.committed)runtime.invalidate()
    return out.result
   })
   queue=job.catch(()=>{});return job
  }
  const read=new Set(['readPersona','getMeta','list','search','core','working','stats','listBackups'])
  const api={drain:()=>queue,write:(...args)=>submit('write',args),update:(...args)=>submit('update',args),expireTide:(...args)=>submit('expireTide',args),
   close:async()=>{closed=true;await queue;original.db.close()}}
  runtime.store=api
  return new Proxy(api,{get(target,key){
   if(key in target)return target[key]
   if(read.has(key))return original[key].bind(original)
   if(['dir','dbPath','backupDir','exportDir'].includes(key))return original[key]
   if(key==='logRetrieval')return ()=>{} // no plaintext-query log path
   return ()=>{throw new Error('protected/unsupported store capability: '+String(key))}
  }})
 }
}
