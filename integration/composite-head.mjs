// Compare one continuous history across all three stores. No synchronization or lease entrypoint.
import {createHash} from 'node:crypto'
const order=v=>Array.isArray(v)?v.map(order):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,order(v[k])])):v
const digest=v=>createHash('sha256').update(JSON.stringify(order(v))).digest('hex')
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
function check(head){
 if(head?.format!=='tidemind-composite-v1')throw Error('composite head format required')
 for(const kind of ['sqlite','json','persona',...(head.aiMemory?['aiMemory']:[])]){
  const row=head[kind];if(!row||!Number.isSafeInteger(row.revision)||row.revision<0||!hex(row.baseline)||!(hex(row.hash)||kind==='sqlite'&&row.revision===0&&row.hash==='GENESIS'))throw Error('invalid composite '+kind+' head')
 }
 if(!hex(head.sqlite.dataHash)||!hex(head.sqlite.protectedHash)||head.digest!==digest({format:head.format,sqlite:head.sqlite,json:head.json,persona:head.persona,...(head.aiMemory?{aiMemory:head.aiMemory}:{})}))throw Error('composite digest mismatch')
}
export function createCompositeHead({sqlite,jsonMemory,persona,aiMemory}){
 const result={format:'tidemind-composite-v1',sqlite:{revision:sqlite.revision,hash:sqlite.hash,baseline:sqlite.baseline_hash,dataHash:sqlite.data_hash,protectedHash:sqlite.protected_hash},json:{revision:jsonMemory.overlayRevision,hash:jsonMemory.overlayHash,baseline:jsonMemory.baselineSha256},persona:{revision:persona.overlayVersion,hash:persona.currentHash,baseline:persona.sha256}}
 if(aiMemory)result.aiMemory={revision:aiMemory.revision,hash:aiMemory.hash,baseline:aiMemory.baseline}
 result.digest=digest(result);check(result);return Object.freeze(result)
}
export function assertCompositeAgreement(sourceAck,targetAck,{required=false}={}){
 if(!required&&!sourceAck?.composite&&!targetAck?.composite)return
 if(required&&(!sourceAck?.composite?.aiMemory||!targetAck?.composite?.aiMemory))throw Error('independent ai-memory coverage missing; handover blocked')
 for(const ack of [sourceAck,targetAck]){
  check(ack?.composite);const s=ack.composite.sqlite
  if(s.revision!==ack.revision||s.hash!==ack.hash||s.dataHash!==ack.data_hash||s.baseline!==ack.baseline_hash||s.protectedHash!==ack.protected_hash)throw Error('composite SQLite receipt differs from replica acknowledgement')
 }
 if(sourceAck.composite.digest!==targetAck.composite.digest)throw Error('composite histories differ; stop handover and retain both copies')
}
export function assertCompositeTakeover(targetAck,expected){
 if(!targetAck?.composite?.aiMemory||!expected?.aiMemory)throw Error('independent ai-memory coverage missing; takeover blocked')
 check(targetAck?.composite);check(expected)
 assertCompositeAgreement({...targetAck,composite:expected},targetAck,{required:true})
}
