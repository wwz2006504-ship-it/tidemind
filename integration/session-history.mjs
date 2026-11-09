// Trusted host-only adapter. Uses the installed DSH persistence read handle, never live projections.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
export function createSessionHistoryReader(persistence){
 if(typeof persistence?.open!=='function')throw Error('DSH persistence service required')
 return async({sessionId,id,contentHash,sourceOrigin='qq-user'})=>{
  let handle
  try{
   handle=await persistence.open(sessionId,'read')
   if(handle.access!=='read'||handle.header?.id!==sessionId||handle.inheritedEventCount!==0)throw Error('untrusted or inherited session history')
   const first=await handle.read(0),second=await handle.read(0)
   if(!Array.isArray(first.events)||!Array.isArray(second.events)||hash(first.events)!==hash(second.events))throw Error('session history changed during verification')
   const events=second.events,pending={'next-turn':[],'next-step':[]};let found=false,consumed=false
   for(let seq=0;seq<events.length;seq++){
    const e=events[seq];if(e.seq!==seq)throw Error('incomplete session history')
    if(e.type==='agent/inbox/spliced'){
     const d=e.data,list=pending[d?.target],removed=d?.removedCount??0
     if(!list||!Array.isArray(d.inserted)||!Number.isSafeInteger(d.start)||d.start<0||d.start>list.length||!Number.isSafeInteger(removed)||removed<0||d.start+removed>list.length)throw Error('invalid inbox history')
     for(const m of d.inserted)if(m.id===id){check(m);found=true}
     list.splice(d.start,removed,...d.inserted)
     const ids=[...pending['next-turn'],...pending['next-step']].map(m=>m.id)
     if(new Set(ids).size!==ids.length)throw Error('duplicate pending identity')
    }
    if(e.type==='user/message'&&e.data?.id===id){check(e.data);found=true;consumed=true}
   }
   function check(m){if(!['qq-user','module-event'].includes(sourceOrigin)||m.role!=='user'||m.source?.kind!=='aurabot'||m.source?.origin!==sourceOrigin||hash(m.content)!==contentHash)throw Error('durable input identity/content conflict')}
   return {state:found?'present':'absent',stage:consumed?'consumed':found?'admitted':'unknown',historyHash:hash(events),eventCount:events.length,pendingCount:pending['next-turn'].length+pending['next-step'].length,automaticReplay:false}
  }catch(error){return {state:'unknown',reason:'durable history unavailable, unstable or conflicting',automaticReplay:false}}
  finally{if(handle)await handle.close()}
 }
}
