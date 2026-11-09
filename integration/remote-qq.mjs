// Async original QQ API transport; no local lease database and no local sender.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {signHistoryAttestation} from './history-attestation.mjs'
import {AsyncLocalStorage} from 'node:async_hooks'
import {stablePokeMessageId,validateReplyItems} from './qq-outbound.mjs'
import {verifyRecoveryBoundary} from './admission-recovery.mjs'
import {createMediaBlobs} from './media-blobs.mjs'
export function createRemoteQQ({authority,term,holder='local',selfId,historyReader,historyKey,toolContext,mediaRoot,mediaReadRoots,sourceContext}){
 if(typeof authority?.request!=='function')throw Error('explicit authority required')
 const request=(path,body={})=>authority.request(path,{...body,term:typeof term==='function'?term():term})
 const inbound=new AsyncLocalStorage(),intents=new AsyncLocalStorage(),pending=new Set()
 const media=mediaRoot?createMediaBlobs({root:mediaRoot,...(mediaReadRoots?{readRoots:mediaReadRoots}:{})}):null,uploaded=new Set()
 const track=fn=>(...args)=>{const work=Promise.resolve().then(()=>fn(...args));pending.add(work);work.finally(()=>pending.delete(work)).catch(()=>{});return work}
 const frame=()=>{const i=inbound.getStore();if(i){if(!i.active)throw Error('inbound send scope ended');return {...i,sequence:i.sequence++}}const f=toolContext?.();if(!f)throw Error('unbound direct send denied');f.guard?.();return f}
 const wire=f=>({sessionId:f.sessionId,turn:f.turn,callId:f.callId,sequence:f.sequence})
 async function withInboundEvent({origin,chatId,label},fn){
  if(!['local','cloud'].includes(holder)||!['command','message-hook'].includes(label)||typeof fn!=='function')throw Error('host inbound operation required')
  const f={sessionId:'host-event:'+origin,turn:0,callId:label,sequence:0,active:true}
  await request('/qq/bind',{binding:{sessionId:f.sessionId,turn:0,chatId,origins:[origin]}})
  try{return await inbound.run(f,fn)}finally{f.active=false}
 }
 async function freezeMessage(message){
  if(!Array.isArray(message))throw Error('original message segments required')
  if(!message.some(s=>['image','record'].includes(s.type)))return message
  if(!media)throw Error('explicit owned remote media store required')
  const frozen=media.freezeMessage(message)
  for(const s of frozen)if(['image','record'].includes(s.type)){
   const ref=s.data.file,key=s.type+':'+ref.blob;if(uploaded.has(key))continue
   const info={id:ref.blob,type:s.type,bytes:ref.bytes},initial=await request('/qq/media/begin',info),bytes=Buffer.from(media.materialize(s.type,ref).slice(9),'base64')
   if(!Number.isSafeInteger(initial.offset)||initial.offset<0||initial.offset>bytes.length)throw Error('remote media offset differs')
   let offset=initial.offset;while(offset<bytes.length){const chunk=bytes.subarray(offset,offset+32*1024),result=await request('/qq/media/chunk',{...info,offset,data:chunk.toString('base64')});if(result.offset!==offset+chunk.length)throw Error('remote chunk acknowledgement differs');offset=result.offset}
   const done=await request('/qq/media/complete',info);if(done.blob!==ref.blob||done.bytes!==ref.bytes)throw Error('remote immutable media differs');uploaded.add(key)
  }
  return frozen
 }
 async function send(value){const intent=intents.getStore();if(intent&&!intent.active)throw Error('send intent ended');const f=intent?.frame||frame();f.guard?.();try{const prepared=value.message?{...value,message:await freezeMessage(value.message)}:value;const result=await request('/qq/send',{frame:wire(f),send:prepared,...(intent?{intent:intent.request}:{})});f.guard?.();return result}catch(error){error.code='TIDEMIND_DELIVERY_UNKNOWN';throw error}}
 async function withSendIntent(requested,fn,onReplay=value=>value){
  const f=frame();f.guard?.();let result
  try{result=await request('/qq/intent-check',{frame:wire(f),intent:requested})}catch(error){error.code='TIDEMIND_DELIVERY_UNKNOWN';throw error}
  if(result.replayed)return onReplay(result)
  if(result.ready!==true)throw Error('unconfirmed send intent')
  const scope={frame:f,request:requested,active:true};try{return await intents.run(scope,fn)}finally{scope.active=false}
 }
 async function admitInput({sessionId,chatId,origins,content,followup,flush,sourceOrigin='qq-user'}){
  if(typeof historyReader!=='function'||typeof followup!=='function'||typeof flush!=='function'||!/^[1-9]\d*$/.test(String(selfId)))throw Error('real client history/flush and self identity required')
  const ids=[...new Set(origins)].sort(),descriptor={sessionId,chatId,origins:ids,content,sourceOrigin},id='tide-input-'+hash([String(selfId),sessionId,chatId,ids]),contentHash=hash(content),read=()=>historyReader({sessionId,id,contentHash,sourceOrigin})
  const send=async phase=>{const current=typeof term==='function'?term():term,proof=await read(),attestation=signHistoryAttestation({key:historyKey,holder,term:current,descriptor,phase,proof});return authority.request('/qq/admission',{term:current,descriptor,phase,attestation})}
  const prepared=await send('before')
  if(prepared.state==='accepted')return prepared
  if(prepared.state!=='dispatching'||prepared.id!==id||prepared.message?.id!==id||hash(prepared.message.content)!==contentHash||prepared.message.source?.origin!==sourceOrigin)throw Error('remote admission plan differs')
  await request('/qq/status');await followup(prepared.message);await flush()
  return send('after')
 }
 async function historyOperation(id,purpose,options={}){
  if(typeof historyReader!=='function')throw Error('actual durable history reader required')
  const descriptor={...await request('/qq/admission-evidence',{id}),purpose},seen=await historyReader({sessionId:descriptor.sessionId,id,contentHash:descriptor.contentHash,sourceOrigin:descriptor.sourceOrigin})
  if(purpose==='recovery'&&(options.agent?.id!==descriptor.sessionId||options.ctx?.agents?.get(options.agent.id)!==options.agent||options.ctx?.sessions?.get(options.agent.id)!==options.agent.session))throw Error('actual exclusive recovery session required')
  let boundary
  if(purpose==='recovery'&&seen.state==='absent'){
   boundary=verifyRecoveryBoundary(options.proof,{ctx:options.ctx,agent:options.agent,baselineCount:descriptor.baselineCount,baselineHash:descriptor.baselineHash})
   if(options.agent.id!==descriptor.sessionId)throw Error('recovery session differs')
  }
  const current=typeof term==='function'?term():term,attestation=signHistoryAttestation({key:historyKey,holder,term:current,descriptor,phase:'before',proof:boundary?{...seen,boundary}:seen})
  const result=await authority.request(purpose==='recovery'?'/qq/recover':'/qq/review',{id,term:current,descriptor,attestation,dryRun:options.dryRun!==false})
  return {result,descriptor,boundary}
 }
 async function recoverAdmission({id,ctx,agent,proof,dryRun=true}){
  const {result,descriptor}=await historyOperation(id,'recovery',{ctx,agent,proof,dryRun})
  if(dryRun||result.state==='accepted')return result
  if(result.state!=='ready'||result.message?.id!==id||hash(result.message.content)!==descriptor.contentHash)throw Error('unconfirmed original recovery plan')
  await request('/qq/status');verifyRecoveryBoundary(proof,{ctx,agent,baselineCount:descriptor.baselineCount,baselineHash:descriptor.baselineHash})
  if(agent.followup(result.message)!==undefined)throw Error('synchronous actual followup required')
  await ctx.sessions.flush(agent.session)
  const confirmed=await historyOperation(id,'review');if(confirmed.result.state!=='accepted')throw Error('recovery outcome unknown; review required')
  return {id,state:'accepted',submitted:true,dryRun:false}
 }
 async function reviewAdmissions(){const status=await request('/qq/admission-status');if(status.admissions.length>64)throw Error('bounded recovery review required');const result=[];for(const row of status.admissions)result.push((await historyOperation(row.id,'review')).result);return result}
 async function reply(binding,render){
  if(typeof binding.replyIdentity!=='string')throw Error('original reply identity required');binding={...binding,replyIdentity:hash(binding.replyIdentity)}
  const existing=await request('/qq/reply-check',{binding});if(!existing.renderRequired)return existing
  const rendered=await render(),capture={...rendered,result:rendered.result||[],sent:[]}
  for(const part of rendered.sent)capture.sent.push(part.message?{...part,message:await freezeMessage(part.message)}:part)
  return request('/qq/reply',{binding,capture})
 }
 return Object.freeze({protocol:track(()=>request('/qq/protocol')),observeInbound:track((event,message)=>request('/qq/observe',{event,message,callbackOp:sourceContext?.()?.op})),observePoke:track((event,message)=>request('/qq/observe-poke',{event,message,callbackOp:sourceContext?.()?.op})),pokeMessageId:event=>stablePokeMessageId(selfId,event),observeAutonomous:track(event=>request('/qq/observe-autonomous',{event})),bindTurn:track(binding=>request('/qq/bind',{binding})),admitInput:track(admitInput),recoverAdmission:track(recoverAdmission),reviewAdmissions:track(reviewAdmissions),recoveryBinding:track(id=>request('/qq/recovery-binding',{id})),purgeExpiredInputs:track(()=>request('/qq/purge')),recoveryStatus:track(()=>request('/qq/admission-status')),audit:track(()=>request('/qq/status')),read:track((action,params={},options={})=>request('/qq/read',{action,params,options})),callTool:track(invocation=>request('/qq/tool',{invocation})),validateItems:validateReplyItems,withInboundEvent:track(withInboundEvent),withSendIntent:track(withSendIntent),send:track(send),guardedClient:Object.freeze({call:async()=>{throw Error('direct OneBot capability denied')}}),idle:async()=>{while(pending.size)await Promise.allSettled([...pending])},reply:track(reply)})
}
