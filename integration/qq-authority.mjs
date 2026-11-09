// Transport adapter for the EXISTING inbox, turn bindings and outbox.
// Trusted server configuration owns target policy and OneBot transport, never request bodies.
import {createQQOutbound} from './qq-outbound.mjs'
import * as gateway from '../TideMind/deploy/existing/tide-gateway.mjs'
import {createSourceAdmission,sourceEventHash} from './source-admission.mjs'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
import {verifyHistoryAttestation} from './history-attestation.mjs'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createMediaUpload} from './media-upload.mjs'
export function createQQAuthority({lease,config,historyKeys}){
 const instances=new Map()
 const sends=new AsyncLocalStorage()
 const uploads=config.mediaProtocol==='immutable-upload-v1'?createMediaUpload({lease}):null
 function current(holder,term){
  lease.fenced(holder,term,db=>{if(db.prepare('SELECT home FROM tide_head').get().home!==holder)throw Error('standby cannot use QQ')})
  const key=holder+':'+term
  if(!instances.has(key)){
   const transport=config.transports ? config.transports[holder] : config.transport
   if(typeof transport!=='function')throw Error('OneBot transport unavailable for active home')
   const binding={...config,transport,lease,gateway,holder,term}
   instances.clear()
   instances.set(key,{outbound:createQQOutbound({...binding,toolContext:()=>sends.getStore()}),source:createSourceAdmission({lease,holder,term}),capabilities:createOneBotCapabilities(binding)})
  }
  return instances.get(key)
 }
 function textCapture(value,chatId){
  if(!value||!Array.isArray(value.sent)||value.result!=null&&!Array.isArray(value.result)||value.sent.length>8||(value.result||[]).some(x=>!(uploads?['text','voice','image','sticker','poke']:['text']).includes(x?.kind)))throw Error('reviewed original reply capture required')
  for(const part of value.sent){
   if(part.chatId!==chatId)throw Error('captured target differs')
   if(part.pokeUserId!==undefined){if(!uploads||!Number.isSafeInteger(part.pokeUserId)||part.pokeUserId<=0)throw Error('remote poke disabled');continue}
   if(!Array.isArray(part.message)||part.message.length>32)throw Error('bounded original segments required')
   for(const s of part.message){if(s?.type==='text'){if(typeof s.data?.text!=='string'||Object.keys(s.data).some(k=>k!=='text'))throw Error('text segment differs')}else if(s?.type==='reply'){if(!/^[-]?[1-9]\d*$/.test(String(s.data?.id)))throw Error('reply reference differs')}else if(!uploads||!['image','record'].includes(s?.type)||typeof s.data?.file!=='object')throw Error('remote media and unreviewed segments disabled')}
  }
  return {...structuredClone(value),result:value.result||[]}
 }
 return {async request(holder,path,body){
  const {outbound,source,capabilities}=current(holder,body.term)
  if(path==='/qq/protocol')return {protocol:'original-host-v1',media:uploads?'immutable-upload-v1':false,history:!!historyKeys?.[holder],source:'canonical-callbacks-v1'}
  if(path==='/qq/source/begin')return source.beginRemote(body.op,body.event)
  if(path==='/qq/source/finish')return source.finishRemote(body.op,body.eventHash,body.success)
  if(path==='/qq/source/callback')return source.callbackStatus(body.op)
  if(path==='/qq/source/status')return source.status()
  if(path==='/qq/source/pause')return source.pause(body.op)
  if(path==='/qq/source/resume')return source.resume(body.op)
  if(path==='/qq/source/replay-claim')return {event:source.claimDeferred(body.op)}
  if(path==='/qq/source/replay-finish')return source.finishDeferred(body.op,body.id,body.success)
  if(path.startsWith('/qq/media/')){if(!uploads)throw Error('remote media protocol not enabled');return uploads.request(holder,body.term,path,body)}
  if(path==='/qq/observe'||path==='/qq/observe-poke'){
   const observed=()=>path==='/qq/observe'?outbound.observeInbound(body.event,body.message):outbound.observePoke(body.event,body.message)
   if(body.callbackOp){const callback=source.callbackStatus(body.callbackOp);if(callback.state!=='active'||callback.holder!==holder||callback.term!==body.term||callback.event_hash!==sourceEventHash(body.event))throw Error('actual source callback differs');return observed()}
   return source.dispatch(body.event,observed)
  }
  if(path==='/qq/observe-autonomous')return outbound.observeAutonomous(body.event)
  if(path==='/qq/bind')return {key:outbound.bindTurn(body.binding)}
  if(path==='/qq/purge')return outbound.purgeExpiredInputs()
  if(path==='/qq/recovery-binding')return outbound.recoveryBinding(body.id)
  if(path==='/qq/admission-evidence')return outbound.admissionEvidence(body.id)
  if(path==='/qq/review'||path==='/qq/recover'){
   const purpose=path==='/qq/recover'?'recovery':'review',descriptor={...outbound.admissionEvidence(body.id),purpose}
   if(gateway.hash(descriptor)!==gateway.hash(body.descriptor))throw Error('original admission evidence changed')
   const seen=verifyHistoryAttestation({key:historyKeys?.[holder],holder,term:body.term,descriptor,phase:'before',attestation:body.attestation})
   if(path==='/qq/recover')return outbound.reserveAdmissionRecovery({id:body.id,sessionId:descriptor.sessionId,seen,boundary:seen.boundary,dryRun:body.dryRun!==false})
   const reader=createQQOutbound({...config,lease,gateway,holder,term:body.term,historyReader:async request=>{if(request.id!==body.id)throw Error('different history requested');return seen}})
   return (await reader.reviewAdmissions({ids:[body.id]}))[0]
  }
  if(path==='/qq/send'||path==='/qq/intent-check'){
   const f=body.frame
   if(!f||typeof f.sessionId!=='string'||!f.sessionId||typeof f.callId!=='string'||!f.callId||!Number.isSafeInteger(f.turn)||f.turn<0||!Number.isSafeInteger(f.sequence)||f.sequence<0||f.sequence>10000)throw Error('exact bound send frame required')
   const frame={...f,guard:()=>lease.fenced(holder,body.term,db=>{if(db.prepare('SELECT home FROM tide_head').get().home!==holder)throw Error('stale send frame')})}
   return sends.run(frame,()=>{
    if(path==='/qq/intent-check')return outbound.withSendIntent(body.intent,async()=>({ready:true}),value=>value)
    return body.intent?outbound.withSendIntent(body.intent,()=>outbound.send(body.send),value=>value):outbound.send(body.send)
   })
  }
  if(path==='/qq/status')return outbound.audit()
  if(path==='/qq/admission-status')return outbound.recoveryStatus()
  if(path==='/qq/admission'){
   const {descriptor,phase,attestation}=body
   const proof=verifyHistoryAttestation({key:historyKeys?.[holder],holder,term:body.term,descriptor,phase,attestation})
   const admission=createQQOutbound({...config,lease,gateway,holder,term:body.term,historyReader:async()=>proof})
   let message
   try{return await admission.admitInput({...descriptor,followup:async value=>{if(phase!=='before'||proof.state!=='absent')throw Error('unexpected remote submission');message=value;throw Error('client dispatch handshake required')},flush:async()=>{throw Error('server cannot flush client history')}})}
   catch(error){if(message)return {id:message.id,state:'dispatching',message,automaticReplay:false};throw error}
  }
  if(path==='/qq/read'){
   if(typeof body.action!=='string'||body.action.startsWith('send_'))throw Error('chat sends require bound outbox')
   return capabilities.moduleClient.call(body.action,body.params,body.options)
  }
  if(path==='/qq/tool'){
   const invocation=body.invocation,grant=await capabilities.grantTool(invocation)
   if(!grant.ticket){if(grant.state==='succeeded')return {replayed:true};throw Error('tool outcome requires review; automatic retry denied')}
   return capabilities.executeGrantedCall(grant.ticket,{sessionId:invocation.sessionId,callId:invocation.callId})
  }
  if(path==='/qq/reply-check'||path==='/qq/reply'){
   if(!/^[a-f0-9]{64}$/.test(body.binding?.replyIdentity||''))throw Error('stable hashed original reply identity required')
   if(path==='/qq/reply-check'){
    let missing=false
    try{return await outbound.reply(body.binding,async()=>{missing=true;throw Error('client render handshake required')})}catch(error){if(missing)return {renderRequired:true};throw error}
   }
   const capture=textCapture(body.capture,body.binding.chatId)
   const binding={...body.binding,renderHash:gateway.hash(capture)}
   return outbound.reply(binding,async()=>capture)
  }
  throw Error('unknown original QQ operation')
 },async idle(){await Promise.all([...instances.values()].map(x=>x.outbound.idle()))}}
}
