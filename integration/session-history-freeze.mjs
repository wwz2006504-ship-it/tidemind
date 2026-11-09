// Host-side stop boundary using the ORIGINAL SDK's real writer ownership.
// This does not pause QQ, grant a lease, seal memories, or authorize handover.
import {realpathSync} from 'node:fs'
import {openNativeSessionStorage} from './native-session-storage.mjs'
import {captureSessionHistoryBundle,assertSessionBundleExtension} from './session-history-bundle.mjs'

export async function freezeStoppedSessionHistory({ctx,mappings,historyRoot,stopRuntime,previous,dryRun=false}){
 const agents=ctx.agents,sessions=ctx.sessions,persistence=ctx.sessionPersistence
 if(!agents||!sessions||!persistence||typeof stopRuntime!=='function')throw Error('original runtime and explicit stop boundary required')
 const preview=await captureSessionHistoryBundle({persistence,mappings,previous:dryRun?previous:undefined})
 const live=[...new Set([...preview.sessions,...(previous?.sessions||[])].map(s=>s.header.id))].map(id=>agents.get(id)).filter(Boolean)
 for(const agent of live)if(agent.status!=='idle'||agent.inbox?.hasPending!==false||sessions.get(agent.id)!==agent.session)throw Error('original sessions must drain before stop')
 if(dryRun)return {dryRun:true,sessionCount:preview.sessions.length,baselineDigest:preview.digest,stopped:false}
 for(const agent of live)await sessions.flush(agent.session)
 const baseline=await captureSessionHistoryBundle({persistence,mappings,previous})
 const locations=new Map(baseline.sessions.map(s=>[s.header.id,realpathSync(persistence.locate(s.header).path)]))
 await stopRuntime()
 for(const s of baseline.sessions)if(agents.get(s.header.id)!==undefined||sessions.get(s.header.id)!==undefined)throw Error('original runtime still owns session; no freeze proof')
 const backend=await openNativeSessionStorage(historyRoot),handles=[];let released=false,releasing
 const release=()=>releasing??=(async()=>{
  released=true;const results=await Promise.allSettled(handles.map(h=>h.close()))
  try{await backend.close()}catch(error){results.push({status:'rejected',reason:error})}
  const failures=results.filter(r=>r.status==='rejected').map(r=>r.reason)
  if(failures.length)throw new AggregateError(failures,'session freeze release failed')
 })()
 try{
  for(const s of baseline.sessions){
   if(realpathSync(backend.persistence.locate(s.header).path)!==locations.get(s.header.id))throw Error('stopped history root differs from original')
   const handle=await backend.persistence.open(s.header.id,'write');handles.push(handle)
   if(handle.access!=='write'||handle.header.id!==s.header.id||handle.inheritedEventCount!==0)throw Error('exclusive original history ownership unavailable')
  }
  async function snapshot(){
   if(released)throw Error('session freeze already released')
   for(const s of baseline.sessions)if(agents.get(s.header.id)!==undefined||sessions.get(s.header.id)!==undefined)throw Error('old session runtime revived')
   const bundle=await captureSessionHistoryBundle({persistence:backend.persistence,mappings,previous:baseline})
   if(released)throw Error('session freeze released during capture')
   assertSessionBundleExtension(baseline,bundle);return bundle
  }
  const bundle=await snapshot()
  return Object.freeze({bundle,snapshot,release,scope:'stopped-original-sdk-histories-only',authorizesHandover:false})
 }catch(error){try{await release()}catch(cleanup){throw new AggregateError([error,cleanup],'history freeze and cleanup failed')}throw error}
}
