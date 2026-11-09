// Host-only, in-process proof of a clean local shutdown. Not a transferable/cloud certificate.
import {readFileSync} from 'node:fs'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
const proofs=new WeakMap()
function snapshot(file,sessionId){
 const path=checkedPath(file),a=readFileSync(path),b=readFileSync(path)
 if(!a.equals(b)||!a.length||a.at(-1)!==10)throw Error('incomplete or changing physical history')
 const rows=a.toString('utf8').split('\n');rows.pop()
 const [header,...events]=rows.map(line=>JSON.parse(line))
 if(header.type!=='session'||header.version!==4||header.id!==sessionId||header.isSeeded!==false)throw Error('current complete unseeded history required')
 for(let i=0;i<events.length;i++)if(events[i].seq!==i)throw Error('non-contiguous physical history')
 return {path,bytes:a,diskHash:hash(a.toString('base64')),events,historyHash:hash(events)}
}
export async function stopForAdmissionRecovery({ctx,agent,closeRuntime}){
 if(typeof closeRuntime!=='function'||ctx.agents.get(agent.id)!==agent||ctx.sessions.get(agent.id)!==agent.session||agent.status!=='idle')throw Error('owned idle runtime required')
 const agents=ctx.agents,sessions=ctx.sessions,sessionId=agent.id,file=ctx.sessionPersistence.locate(agent.session.header).path
 await ctx.sessions.flush(agent.session)
 await closeRuntime()
 if(agents.get(sessionId)!==undefined||sessions.get(sessionId)!==undefined)throw Error('old runtime has not released session')
 const frozen=snapshot(file,sessionId),token=Object.freeze({kind:'local-clean-stop'})
 proofs.set(token,{...frozen,sessionId,oldAgent:agent});return token
}
export function verifyRecoveryBoundary(token,{ctx,agent,baselineCount,baselineHash}){
 const proof=proofs.get(token)
 if(!proof||proof.sessionId!==agent.id||proof.oldAgent===agent||ctx.agents.get(agent.id)!==agent||ctx.sessions.get(agent.id)!==agent.session||agent.status!=='idle'||agent.inbox?.hasPending)throw Error('fresh exclusive idle session and clean-stop proof required')
 const file=ctx.sessionPersistence.locate(agent.session.header).path,current=snapshot(file,agent.id)
 if(current.path!==proof.path||current.bytes.length<proof.bytes.length||!current.bytes.subarray(0,proof.bytes.length).equals(proof.bytes))throw Error('history changed since clean shutdown')
 const added=current.events.slice(proof.events.length)
 // Native DSH restoration appends one end-seed marker even for an empty ordinary session.
 if(added.length>1||added.some(e=>e.type!=='session/end-seed'||hash(e.data)!==hash({})||Object.keys(e).some(k=>!['type','seq','time','data'].includes(k))))throw Error('unexpected events after clean shutdown')
 if(!Number.isSafeInteger(baselineCount)||baselineCount<0||baselineCount>current.events.length||hash(current.events.slice(0,baselineCount))!==baselineHash)throw Error('original history prefix missing or rolled back')
 return {historyHash:current.historyHash,eventCount:current.events.length}
}

