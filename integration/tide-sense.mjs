// TideSense: a real-time self-state SNAPSHOT with strict separation of what was observed, what is planned, and what is done.
// This module only holds and labels state. It does NOT read Minecraft: a reader must feed observe() from the real API.
// Nothing here can turn a plan into an observation or a completion; completion needs its own evidence.
const OBSERVED=['world','position','facing','health','hunger','equipment','inventory','dangers']
const bounded=(s,n,name)=>{if(typeof s!=='string'||!s.trim()||s.length>n)throw Error(name+' must be bounded text');return s.trim()}
export function createSense({clock=Date.now,staleMs=5000,maxEvents=20}={}){
 const obs={},plan={goal:null,action:null,next:null,at:0},done=[],events=[];let conn={connected:false,at:0,reason:'never connected'}
 const push=(kind,what)=>{events.push({at:clock(),kind,what});while(events.length>maxEvents)events.shift()}
 function observe(fields){
  if(!conn.connected)throw Error('not connected; observations refused')
  const now=clock()
  for(const [k,v] of Object.entries(fields)){if(!OBSERVED.includes(k))throw Error('not an observable field: '+k);obs[k]={value:structuredClone(v),at:now}}
 }
 const connect=()=>{conn={connected:true,at:clock(),reason:''}}
 // Losing the connection makes every observation stale at once and clears nothing silently.
 function disconnect(reason){conn={connected:false,at:clock(),reason:bounded(reason,200,'reason')};push('failure','disconnected: '+reason)}
 function setPlan({goal,action,next}){plan.goal=goal?bounded(goal,300,'goal'):null;plan.action=action?bounded(action,300,'action'):null;plan.next=next?bounded(next,300,'next'):null;plan.at=clock()}
 // A completion must cite the observation that proves it; a bare "I did it" is refused.
 function complete({action,evidence}){
  bounded(action,300,'action')
  if(!evidence||!OBSERVED.includes(evidence.field)||!obs[evidence.field])throw Error('completion needs an observed field as evidence')
  if(clock()-obs[evidence.field].at>staleMs)throw Error('evidence is stale')
  done.push({action,evidence:{field:evidence.field,observedAt:obs[evidence.field].at},at:clock()});push('success',action)
  if(plan.action===action)plan.action=null
 }
 const fail=(action,why)=>push('failure',bounded(action,200,'action')+': '+bounded(why,200,'why'))
 function snapshot(){
  const now=clock(),observed={}
  for(const k of OBSERVED){const o=obs[k];observed[k]=o?{value:structuredClone(o.value),at:o.at,stale:!conn.connected||now-o.at>staleMs}:{value:null,at:0,stale:true}}
  return Object.freeze({at:now,connection:{...conn},observed,planned:{...plan},completed:done.slice(-10),events:events.slice(),
   anyStale:Object.values(observed).some(o=>o.stale)})
 }
 return {observe,connect,disconnect,setPlan,complete,fail,snapshot,OBSERVED}
}
