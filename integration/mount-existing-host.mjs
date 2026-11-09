// Cordis lifecycle adapter for the SAME original host entry. No network entrypoint.
import * as host from '../host/aurabot/src/host.js'
const mounts=new WeakMap()
export async function mountExistingHost(ctx,{bindings,requiredModules}={}){
 if(!bindings?.isolated||requiredModules!==undefined&&!Array.isArray(requiredModules))throw Error('explicit existing host bindings required')
 const previous=mounts.get(ctx)
 if(previous){if(previous.bindings!==bindings)throw Error('another existing host mount owns this context');return previous.promise}
 const record={bindings};mounts.set(ctx,record)
 record.promise=(async()=>{
  let handle,fiber,closed=false,stopping
  const dispose=()=>{
   if(stopping)return stopping
   stopping=(async()=>{
   if(closed)return
   // Keep ownership until real async cleanup has finished.
   if(fiber){await fiber.dispose();if(fiber.inertia)await fiber.inertia}
   closed=true;if(mounts.get(ctx)===record)mounts.delete(ctx)
   })();return stopping
  }
  try{
   fiber=ctx.plugin({name:'tidemind-existing-aurabot',inject:host.inject.filter(n=>n!=='tidemindHostBindings'),apply(child){
    if(child.get('tidemindHostBindings'))throw Error('existing host bindings provider already mounted')
    child.provide('tidemindHostBindings',bindings)
    handle=host.apply(child)
   }})
   await fiber.await()
   if(!handle)throw Error('original host dependencies unavailable')
   await handle.ready
   const configured=handle.getConfig().modules||{}
   const required=requiredModules??[...new Set([...(bindings.dependencies.BUILTINS||[]).map(m=>m.id),...Object.keys(configured)].filter(id=>configured[id]?.enabled!==false))]
   for(const id of required)if(!handle.modules.running(id))throw Error('required original module failed: '+id)
   return Object.freeze({handle,fiber,dispose})
  }catch(error){await dispose();throw error}
 })()
 return record.promise
}
