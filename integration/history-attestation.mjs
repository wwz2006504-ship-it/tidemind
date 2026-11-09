// Domain-separated use of the EXISTING materializer key, owned by trusted hosts.
import {createHmac,timingSafeEqual} from 'node:crypto'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
const domain='tidemind-durable-input-v1'
function validate(holder,term,descriptor,phase,proof){
 if(!['local','cloud'].includes(holder)||!Number.isSafeInteger(term)||term<1||!['before','after'].includes(phase))throw Error('explicit history principal/term/phase required')
 if(!descriptor||typeof descriptor.sessionId!=='string'||!descriptor.sessionId||!Array.isArray(descriptor.origins)||!descriptor.origins.length||descriptor.origins.length>40||!['qq-user','module-event'].includes(descriptor.sourceOrigin))throw Error('durable input descriptor required')
 if(!['absent','present'].includes(proof?.state)||phase==='after'&&proof.state!=='present'||!Number.isSafeInteger(proof.eventCount)||proof.eventCount<0||!Number.isSafeInteger(proof.pendingCount)||proof.pendingCount<0||!/^[a-f0-9]{64}$/.test(proof.historyHash||''))throw Error('stable actual durable history evidence required')
 if(proof.state==='present'&&!['admitted','consumed'].includes(proof.stage))throw Error('confirmed durable input stage required')
}
const signature=(key,payload)=>{if(typeof key!=='string'||key.length<32)throw Error('private materializer key required');return createHmac('sha256',key).update(domain+'\n'+hash(payload)).digest('hex')}
export function signHistoryAttestation({key,holder,term,descriptor,phase,proof}){
 validate(holder,term,descriptor,phase,proof)
 const payload={format:domain,holder,term,descriptorHash:hash(descriptor),phase,proof,expiresAt:Date.now()+30000}
 return {...payload,signature:signature(key,payload)}
}
export function verifyHistoryAttestation({key,holder,term,descriptor,phase,attestation}){
 validate(holder,term,descriptor,phase,attestation?.proof)
 const {signature:given,...payload}=attestation
 if(payload.format!==domain||payload.holder!==holder||payload.term!==term||payload.phase!==phase||payload.descriptorHash!==hash(descriptor)||!Number.isSafeInteger(payload.expiresAt)||payload.expiresAt<Date.now()||payload.expiresAt>Date.now()+60000||!/^[a-f0-9]{64}$/.test(given||''))throw Error('history attestation binding or lifetime differs')
 if(!timingSafeEqual(Buffer.from(given,'hex'),Buffer.from(signature(key,payload),'hex')))throw Error('history attestation signature differs')
 return structuredClone(payload.proof)
}
