import {createOwnedAgentDrain} from './owned-agent-drain.mjs'
import {createSourceQuiescer} from './source-quiescer.mjs'
import {inspectAuthorityQuiet} from './authority-quiet.mjs'
export function createRuntimeTransferDrain({ctx,authority,registry,driver,host,supervisor,sourceAdmission,memoryBarrier,compositeHead,drainMemory,exportTasks}){
 const agents=createOwnedAgentDrain({registry,resolveAgent:id=>ctx.agents.get(id),cognitiveAgent:driver.agent,flushSession:s=>ctx.sessions.flush(s)})
 function assemble(tasks,sql){
  const agent=agents.status(),hub=host.hub.incomingStatus(),modules=host.modules.transferStatus(),lifecycle=host.transferLifecycle.status()
  const blockers=[]
  const room=host.modules.use?.('my-agent-room3d')?.transferStatus?.()
  if(room?.pending)blockers.push('room-command-unconfirmed')
  if(agent.busy||agent.pending)blockers.push('agents-busy')
  if(hub.pending||hub.active||hub.busy||hub.failures)blockers.push('hub-not-drained')
  if(modules.active||modules.failures||modules.syncing||modules.lifecycle.active||modules.lifecycle.failures)blockers.push('modules-not-drained')
  if(lifecycle.watchdogActive||!lifecycle.watchdogPaused||lifecycle.panel.active||lifecycle.panel.failures)blockers.push('host-not-drained')
  if(!lifecycle.sessionEvents||lifecycle.sessionEvents.active||lifecycle.sessionEvents.failures)blockers.push('session-events-not-drained')
  if(tasks.active||tasks.clientFailures||tasks.tasks.some(t=>['running','needs_review'].includes(t.state)))blockers.push('tasks-not-drained')
  if(!sql.quiet)blockers.push('authority-not-drained')
  const drained=blockers.length===0
  blockers.push('module-external-resources-unverified','module-session-event-admission-unverified')
  return {drained,quiet:false,wholeRuntimeQuiet:false,blockers,agents:agent,authority:sql,scope:'candidate-runtime-drain'}
 }
 const inspect=()=>authority.mode==='remote'?Promise.all([supervisor.status(),authority.request('/transfer/quiet',{term:authority.term})]).then(([tasks,sql])=>assemble(tasks,sql)):assemble(supervisor.status(),inspectAuthorityQuiet(authority))
 const quiescer=createSourceQuiescer({sourceAdmission,memoryBarrier,compositeHead,steps:{
  tasks:()=>supervisor.idle(),hub:options=>host.hub.drainIncoming(options),agents:options=>agents.drain(options),sessions:()=>agents.flush(),memory:()=>drainMemory(),outbound:async options=>{await host.transferLifecycle.drainSessionEvents(options);await host.transferLifecycle.drainOutbound()},modules:async options=>{await host.transferLifecycle.drainPanel(options);await host.transferLifecycle.drainWatchdog();await host.modules.drainCallbacks(options);await host.modules.drainLifecycle(options)},
 },verifyQuiet:inspect,...(exportTasks?{exportTasks}:{})})
 return {inspect,drain:quiescer.drain,prepare:authority.mode==='remote'?async(op,options={})=>{if(options.dryRun)return {dryRun:true,changesAuthority:false,order:['pause','callbacks','tasks','hub','agents','sessions','memory','outbound','modules','verify','freeze','seal']};const proof=await inspect();throw Error('remote runtime transfer blocked: '+proof.blockers.join(', '))}:quiescer.prepare}
}
