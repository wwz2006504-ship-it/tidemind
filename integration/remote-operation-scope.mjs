// Stable original tool-call identities survive retries without changing the original tool API.
import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
const scope=new AsyncLocalStorage()
// Payload belongs in operationHash, not the identity: changed bytes for one call conflict.
export const remoteOperationId=(component,operation)=>{const context=scope.getStore();return context?hash({context,component}):randomUUID()}
export function wrapRemoteOperationTool(tool){return {...tool,execute:(args,exec)=>{
 const agent=exec?.agent,callId=exec?.callId
 if(!agent?.id||agent.session?.id!==agent.id||typeof callId!=='string'||!callId)throw Error('actual original tool call identity required')
 return scope.run({agentId:agent.id,sessionId:agent.session.id,callId,turn:agent.turn||0,tool:tool.name},()=>tool.execute(args,exec))
}}}
