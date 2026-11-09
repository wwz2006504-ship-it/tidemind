// Authenticated incremental files for OFFLINE candidates, not a sender, lease service or live installer.
import {readFileSync,writeFileSync,statSync,existsSync,mkdirSync,renameSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {createHash,createHmac,timingSafeEqual,randomUUID} from 'node:crypto'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
import {assertCompositeAgreement} from './composite-head.mjs'
import {checkedSessionHistoryBundle} from './session-history-bundle.mjs'
import {assertHistoryAckAgreement} from './session-history-authority.mjs'
const slots=['memory.db','new-memories.json','persona-versions.json','ledger.jsonl'],MAX=48*1024*1024
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v
const canonical=v=>JSON.stringify(ordered(v)),sha=b=>createHash('sha256').update(b).digest('hex')
function bytes(path){const p=checkedPath(path);if(statSync(p).size>MAX)throw Error('sync file size limit');const b=readFileSync(p);if(b.length>MAX)throw Error('sync file size limit');return b}
function validateHead(head){const s=head?.sqlite,ack={revision:s?.revision,hash:s?.hash,data_hash:s?.dataHash,baseline_hash:s?.baseline,protected_hash:s?.protectedHash,composite:head};assertCompositeAgreement(ack,ack,{required:true})}
function lineage(base,next){validateHead(base);validateHead(next);for(const k of ['sqlite','json','persona','aiMemory']){const a=base[k],b=next[k];if(a.baseline!==b.baseline||b.revision<a.revision||b.revision===a.revision&&b.hash!==a.hash)throw Error('older, branched or foreign history') }}
function sign(body,secret){if(typeof secret!=='string'||secret.length<32)throw Error('private sync signing key required');return createHmac('sha256',secret).update(canonical(body)).digest('hex')}
function route(body,authorizeHandover){
 if(typeof body.op!=='string'||!body.op||body.op.length>160||!Number.isSafeInteger(body.term)||body.term<1)throw Error('bounded sync identity and term required')
 if(body.mode==='replicate'&&body.holder==='local'&&body.target==='cloud')return
 if(body.mode!=='handover'||body.holder!=='cloud'||body.target!=='local'||typeof authorizeHandover!=='function')throw Error('reverse synchronization requires reviewed handover')
 const decision=authorizeHandover({op:body.op,holder:body.holder,term:body.term,target:body.target,baseDigest:body.baseHead.digest,nextDigest:body.nextHead.digest})
 if(decision&&typeof decision.then==='function'){decision.catch(()=>{});throw Error('synchronous reviewed handover validator required')}
}
function patch(before,after){let prefix=0;while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;let suffix=0;while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++
 return {before:sha(before),after:sha(after),prefix,remove:before.length-prefix-suffix,insert:after.subarray(prefix,after.length-suffix).toString('base64'),size:after.length}}
// Building bytes claims no lease. A remote source must submit this body to the original
// authority, which signs only its matching sealed four-store frontier and reviewed intent.
export function prepareSyncDeltaBody({baseDirectory,nextDirectory,baseHead,nextHead,op,holder,term,target,mode='replicate',history}){
 lineage(baseHead,nextHead)
 const files=Object.fromEntries(slots.map(name=>[name,patch(bytes(join(baseDirectory,name)),bytes(join(nextDirectory,name)))]))
 const body={format:'tidemind-sync-delta-v1',op,holder,term,target,mode,baseHead,nextHead,files,...(history?{history}:{})};validatePacketHistory(body);return body
}
export function validatePacketHistory(body){
 if(!body.history){if(process.env.TIDEMIND_REQUIRE_SESSION_HISTORY==='1')throw Error('session history missing from sync packet');return}
 const h=body.history,bundle=checkedSessionHistoryBundle(h.bundle)
 if(h.baseDigest!==null&&!/^[a-f0-9]{64}$/.test(h.baseDigest||'')||h.head?.digest!==bundle.digest||h.head.fourDigest!==body.nextHead.digest||h.head.op!==body.op||h.head.sourceHolder!==body.holder||h.head.sourceTerm!==body.term||!Number.isSafeInteger(h.head.revision)||h.head.revision<1||!/^[a-f0-9]{64}$/.test(h.head.baseline||''))throw Error('signed history packet frontier differs')
}
const ackOf=(head,history)=>({revision:head.sqlite.revision,hash:head.sqlite.hash,data_hash:head.sqlite.dataHash,baseline_hash:head.sqlite.baseline,protected_hash:head.sqlite.protectedHash,composite:head,...(history?{history}:{})})
const sealedGrant=(body,bodyDigest)=>({scheme:'sealed-digest-v1',bodyDigest,op:body.op,holder:body.holder,term:body.term,target:body.target,mode:body.mode,baseDigest:body.baseHead.digest,headDigest:body.nextHead.digest})
export function describeSealedDelta(body){lineage(body.baseHead,body.nextHead);validatePacketHistory(body);return {format:'tidemind-sealed-delta-request-v1',bodyDigest:sha(canonical(body)),op:body.op,holder:body.holder,term:body.term,target:body.target,mode:body.mode,baseHead:body.baseHead,nextHead:body.nextHead,...(body.history?{historyHead:body.history.head}:{})}}
export function assertSealedDeltaGrant(db,{op,holder,term,target,baseDigest,headDigest,packetSignature}){
 const grant=db.prepare('SELECT * FROM tide_sync_signatures WHERE op=?').get(op)
 if(!grant)return false
 if(grant.holder!==holder||grant.term!==term||grant.target!==target||grant.base_digest!==baseDigest||grant.head_digest!==headDigest||packetSignature!==undefined&&grant.signature!==packetSignature)throw Error('sealed signature grant mismatch')
 const gate=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get(),barrier=db.prepare('SELECT * FROM tide_memory_barrier WHERE id=1').get()
 if(gate.state!=='paused'||gate.op!==op||gate.holder!==holder||gate.term!==term||gate.active!==0||db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state!='forwarded'").get().n||db.prepare("SELECT count(*) n FROM tide_outbox WHERE state!='sent'").get().n)throw Error('sealed signature source no longer quiescent')
 if(barrier.state!=='sealed'||barrier.op!==op||barrier.holder!==holder||barrier.term!==term||JSON.parse(barrier.head).digest!==headDigest)throw Error('sealed signature frontier revoked')
 return true
}
export function signSealedReverseDelta({lease,principal,body,ticketId,secret,authorizeHandover}){
 if(principal!=='cloud'||body?.holder!==principal||body.target!=='local'||body.mode!=='handover'||body.op!==ticketId||typeof authorizeHandover!=='function'||body.format!=='tidemind-sealed-delta-request-v1'||!/^[a-f0-9]{64}$/.test(body.bodyDigest||''))throw Error('sealed reverse signing identity required')
 lineage(body.baseHead,body.nextHead)
 return lease.fenced(principal,body.term,db=>{
  route(body,authorizeHandover)
  const gate=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get(),barrier=db.prepare('SELECT * FROM tide_memory_barrier WHERE id=1').get(),head=db.prepare('SELECT * FROM tide_head').get(),s=body.nextHead.sqlite
  if(gate.state!=='paused'||gate.op!==ticketId||gate.holder!==principal||gate.term!==body.term||gate.active!==0||db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state!='forwarded'").get().n)throw Error('source input not quiesced for signed transfer')
  if(db.prepare("SELECT count(*) n FROM tide_outbox WHERE state!='sent'").get().n)throw Error('source delivery unresolved before signing')
  if(barrier.state!=='sealed'||barrier.op!==ticketId||barrier.holder!==principal||barrier.term!==body.term||JSON.parse(barrier.head).digest!==body.nextHead.digest)throw Error('sealed source frontier required for signing')
  if(head.home!==principal||head.revision!==s.revision||head.hash!==s.hash||head.baseline_hash!==s.baseline||head.protected_hash!==s.protectedHash)throw Error('source authority changed before signing')
  const historyAck=ackOf(body.nextHead,body.historyHead);assertHistoryAckAgreement(db,{sourceAck:historyAck,targetAck:historyAck,holder:principal,term:body.term,op:body.op})
  const signature=sign(sealedGrant(body,body.bodyDigest),secret),old=db.prepare('SELECT * FROM tide_sync_signatures WHERE op=?').get(body.op)
  if(old&&(old.signature!==signature||old.body_digest!==body.bodyDigest))throw Error('sealed signature operation conflict')
  if(!old)db.prepare('INSERT INTO tide_sync_signatures VALUES(?,?,?,?,?,?,?,?)').run(body.op,signature,body.bodyDigest,principal,body.term,body.target,body.baseHead.digest,body.nextHead.digest)
  return {signatureScheme:'sealed-digest-v1',signature}
 })
}
export function createSyncDelta({baseDirectory,nextDirectory,baseHead,nextHead,op,holder,term,target,mode='replicate',secret,withSourceFence,readCurrentComposite,authorizeHandover,history}){
 if(typeof withSourceFence!=='function'||typeof readCurrentComposite!=='function')throw Error('existing source fence and live composite reader required')
 const body=prepareSyncDeltaBody({baseDirectory,nextDirectory,baseHead,nextHead,op,holder,term,target,mode,history})
 return withSourceFence({holder,term},db=>{route(body,authorizeHandover);if(readCurrentComposite().digest!==nextHead.digest)throw Error('source advanced; capture a new snapshot');if(history){if(!db?.prepare)throw Error('actual original history authority transaction required');const ack=ackOf(nextHead,history.head);assertHistoryAckAgreement(db,{sourceAck:ack,targetAck:ack,holder,term,op})}return {...body,signature:sign(body,secret)}})
}
export function authenticateSyncDelta(packet,secret){
 if(!packet||canonical(packet).length>280*1024*1024)throw Error('sync packet size limit')
 const {signature,signatureScheme,...body}=packet
 if(signatureScheme!==undefined&&signatureScheme!=='sealed-digest-v1')throw Error('unknown sync signature scheme')
 const expected=signatureScheme?sign(sealedGrant(body,sha(canonical(body))),secret):sign(body,secret)
 if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))throw Error('sync signature invalid')
 if(body.format!=='tidemind-sync-delta-v1'||canonical(Object.keys(body.files).sort())!==canonical([...slots].sort()))throw Error('sync format or file set invalid')
 validatePacketHistory(body)
 return body
}
export async function stageSyncDelta({packet,baseDirectory,expectedBase,stagingDirectory,secret,withSourceFence,verifyGeneration,authorizeHandover,checkAuthority,dryRun=false}){
 if((typeof withSourceFence!=='function'&&typeof checkAuthority!=='function')||typeof verifyGeneration!=='function')throw Error('existing authority fence and domain verifier required')
 const body=authenticateSyncDelta(packet,secret),signature=packet.signature
 lineage(body.baseHead,body.nextHead);validateHead(expectedBase)
 if(expectedBase.digest!==body.baseHead.digest)throw Error('target base differs; do not overwrite newer history')
 const verifyAuthority=async()=>{
  if(checkAuthority){const proof=await checkAuthority(body);if(proof?.authorized!==true||proof.holder!==body.holder||proof.term!==body.term||proof.target!==body.target||proof.headDigest!==body.nextHead.digest)throw Error('remote source authority check rejected');route(body,()=>proof);return}
  const result=withSourceFence({holder:body.holder,term:body.term},()=>route(body,authorizeHandover));if(result&&typeof result.then==='function'){result.catch(()=>{});throw Error('synchronous existing authority fence required')}
 }
 await verifyAuthority();const actualBase=await verifyGeneration(checkedPath(baseDirectory));if(actualBase.digest!==expectedBase.digest)throw Error('target files changed since acknowledgement')
 const decoded={}
 for(const name of slots){const old=bytes(join(baseDirectory,name)),p=body.files[name]
  if(!p||!Number.isSafeInteger(p.prefix)||!Number.isSafeInteger(p.remove)||!Number.isSafeInteger(p.size)||p.prefix<0||p.remove<0||p.prefix+p.remove>old.length||p.size<0||p.size>MAX||typeof p.insert!=='string'||p.insert.length>MAX*2||sha(old)!==p.before)throw Error('delta base or bounds mismatch')
  const insert=Buffer.from(p.insert,'base64');if(insert.toString('base64')!==p.insert)throw Error('delta encoding invalid')
  const next=Buffer.concat([old.subarray(0,p.prefix),insert,old.subarray(p.prefix+p.remove)]);if(next.length!==p.size||sha(next)!==p.after)throw Error('delta output mismatch');decoded[name]=next
 }
 if(dryRun)return {dryRun:true,op:body.op,head:body.nextHead,servicesChanged:false}
 const dir=checkedPath(stagingDirectory),id='packet-'+sha(body.op),published=join(dir,id)
 if(existsSync(published)){
  if(realpathSync(published)!==published||readFileSync(join(published,'packet-signature'),'utf8')!==signature)throw Error('sync operation conflict')
  for(const name of slots)if(sha(bytes(join(published,name)))!==body.files[name].after)throw Error('replayed candidate bytes changed')
  const actual=await verifyGeneration(published);if(actual.digest!==body.nextHead.digest)throw Error('replayed candidate changed');await verifyAuthority();return {directory:published,head:actual,replayed:true,servicesChanged:false}
 }
 const temp=join(dir,'incoming-'+randomUUID());mkdirSync(temp,{mode:0o700})
 for(const name of slots)writeFileSync(join(temp,name),decoded[name],{flag:'wx',mode:0o600})
 const actual=await verifyGeneration(temp);if(actual.digest!==body.nextHead.digest)throw Error('reconstructed candidate does not match signed head')
 await verifyAuthority();writeFileSync(join(temp,'packet-signature'),signature,{flag:'wx',mode:0o600});renameSync(temp,published)
 return {directory:published,head:actual,replayed:false,servicesChanged:false}
}
