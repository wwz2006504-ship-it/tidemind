// Inspect only original mapped agents plus the dedicated cognitive driver.
// Do not cancel tools or touch unrelated DSH sessions to make a transfer look idle.
export function createOwnedAgentDrain({registry,resolveAgent,cognitiveAgent,flushSession}){
 function agents(){registry.inspect();const ids=[...new Set([...registry.bindings.map(r=>r.agentId),cognitiveAgent.id])];return ids.map(id=>{const agent=resolveAgent(id);if(!agent||agent.id!==id||agent.session?.id!==id||typeof agent.inbox?.hasPending!=='boolean')throw Error('owned agent/inbox evidence unavailable');return agent})}
 function status(){const list=agents();return {agents:list.length,busy:list.filter(a=>a.status!=='idle').length,pending:list.filter(a=>a.inbox.hasPending).length}}
 async function drain({timeoutMs=30000,signal}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('bounded agent drain required')
  const until=performance.now()+timeoutMs
  for(;;){signal?.throwIfAborted();const s=status();if(!s.busy&&!s.pending)return s;if(performance.now()>=until)throw Error('owned agent/inbox drain timed out');await new Promise(r=>setTimeout(r,5))}
 }
 async function flush(){const list=agents();for(const agent of list)await flushSession(agent.session);const s=status();if(s.busy||s.pending)throw Error('owned agent changed during session flush');return s}
 return {status,drain,flush}
}
