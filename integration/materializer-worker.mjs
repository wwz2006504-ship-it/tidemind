// Receives and verifies candidates; it never selects a runtime or acquires a writing lease.
import {readFileSync,writeFileSync,existsSync,realpathSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
import {authenticateSyncDelta,stageSyncDelta} from './sync-delta.mjs'
import {signSyncReceipt} from './sync-receipts.mjs'
import {checkedSessionHistoryBundle,materializeSessionHistoryBundle} from './session-history-bundle.mjs'
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v
const canonical=v=>JSON.stringify(ordered(v)),sha=b=>createHash('sha256').update(b).digest('hex'),slots=['memory.db','new-memories.json','persona-versions.json','ledger.jsonl']
const read=p=>JSON.parse(readFileSync(p,'utf8'))
function atomic(path,value){const tmp=path+'.tmp-'+randomUUID(),fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd)}finally{closeSync(fd)}renameSync(tmp,path)}
export function createMaterializerWorker({target,authority,secret,materializerKey,journalDirectory,stagingDirectory,verifyGeneration,history}){
 if(!['local','cloud'].includes(target)||typeof authority?.request!=='function'||typeof verifyGeneration!=='function'||typeof secret!=='string'||secret.length<32||typeof materializerKey!=='string'||materializerKey.length<32)throw Error('owned materializer configuration required')
 const dir=checkedPath(journalDirectory),stage=checkedPath(stagingDirectory)
 const privateFile=name=>{const p=join(dir,name);checkedPath(p);if(existsSync(p)&&realpathSync(p)!==p)throw Error('materializer metadata link prohibited');return p}
 async function locked(fn){const lock=privateFile('materializer.lock'),nonce=randomUUID()
  if(existsSync(lock)){const old=read(lock);if(!Number.isSafeInteger(old.pid)||old.pid<1||!/^[a-f0-9-]{36}$/.test(old.nonce||''))throw Error('unknown materializer lock')
   let alive=true;try{process.kill(old.pid,0)}catch(e){if(e.code==='ESRCH')alive=false;else throw e}if(alive)throw Error('materializer already active');renameSync(lock,privateFile('abandoned-'+old.nonce+'.json'))}
  const fd=openSync(lock,'wx',0o600);try{writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));fsyncSync(fd)}finally{closeSync(fd)}
  try{return await fn()}finally{if(existsSync(lock)&&read(lock).nonce===nonce)unlinkSync(lock)}
 }
 const sourceCheck=async(body,ticketId,sealed)=>{const proof=await authority.request('/sync/check',{holder:body.holder,term:body.term,target,mode:body.mode,baseDigest:body.baseHead.digest,head:body.nextHead,...(body.history?{historyHead:body.history.head}:{}),ticketId,op:body.op,sealed});if(body.history&&proof.historyDigest!==body.history.head.digest)throw Error('canonical history source differs');return proof}
 function receiptBody(body,head){const s=head.sqlite;return {op:body.op,sourceHolder:body.holder,sourceTerm:body.term,target,baseDigest:body.baseHead.digest,packetSignature:body.packetSignature,ack:{revision:s.revision,hash:s.hash,data_hash:s.dataHash,baseline_hash:s.baseline,protected_hash:s.protectedHash,composite:head,...(body.history?{history:body.history.head}:{})}}}
 async function historyBase(body){
  if(!body.history)return null
  if(typeof history?.readCurrent!=='function'||typeof history.openPersistence!=='function')throw Error('actual destination history reader and native DSH materializer required')
  const current=await history.readCurrent(),base=current?checkedSessionHistoryBundle(current):null
  if((base?.digest||null)!==body.history.baseDigest&&base?.digest!==body.history.bundle.digest)throw Error('destination history base differs; preserve newer history')
  return base
 }
 async function materializeHistory(body,directory,base){if(!body.history)return null;return materializeSessionHistoryBundle({root:join(directory,'session-histories'),source:body.history.bundle,expectedDigest:body.history.head.digest,base,openPersistence:history.openPersistence,workspaceRoot:history.workspaceRoot})}
 async function validateCandidate(record,body,packet){const p=checkedPath(record.directory);if(realpathSync(p)!==p)throw Error('candidate directory changed')
  for(const name of slots)if(sha(readFileSync(checkedPath(join(p,name))))!==packet.files[name].after)throw Error('candidate changed since materialization')
  const head=await verifyGeneration(p);if(head.digest!==body.nextHead.digest)throw Error('candidate composite changed')
  const native=await materializeHistory(body,p,await historyBase(body));if(body.history&&(native.digest!==record.historyDigest||native.directory!==record.historyDirectory||!native.verified))throw Error('native history candidate or receipt differs')
  const unsigned=receiptBody({...body,packetSignature:packet.signature},head),receipt=signSyncReceipt(unsigned,materializerKey)
  if(canonical(receipt)!==canonical(record.receipt)||sha(canonical(unsigned))!==record.receiptHash)throw Error('materializer journal or receipt changed')
 }
 async function receive({packet,baseDirectory,expectedBase,ticketId,dryRun=false,retryUnaccepted=false}){
  const body=authenticateSyncDelta(packet,secret);if(body.target!==target)throw Error('packet targets another materializer')
  const baseHistory=await historyBase(body)
  const checkAuthority=()=>sourceCheck(body,ticketId,packet.signatureScheme==='sealed-digest-v1')
  if(dryRun)return stageSyncDelta({packet,baseDirectory,expectedBase,stagingDirectory:stage,secret,verifyGeneration,checkAuthority,dryRun:true})
  return locked(async()=>{
   const path=privateFile('receipt-'+sha(body.op)+'.json');let record
   if(existsSync(path)){
    record=read(path);if(record.format!=='tidemind-materializer-v1'||record.op!==body.op||record.packetSignature!==packet.signature||!['prepared','submitted','confirmed','rejected'].includes(record.state))throw Error('materializer operation or journal conflict')
    await validateCandidate(record,body,packet)
   }else{
    const candidate=await stageSyncDelta({packet,baseDirectory,expectedBase,stagingDirectory:stage,secret,verifyGeneration,checkAuthority})
    const native=await materializeHistory(body,candidate.directory,baseHistory)
    if(body.history&&!native?.verified)throw Error('actual native history reconstruction unverified')
    const unsigned=receiptBody({...body,packetSignature:packet.signature},candidate.head),receipt=signSyncReceipt(unsigned,materializerKey)
    record={format:'tidemind-materializer-v1',op:body.op,packetSignature:packet.signature,directory:candidate.directory,headDigest:candidate.head.digest,...(native?{historyDirectory:native.directory,historyDigest:native.digest}:{}),receipt,receiptHash:sha(canonical(unsigned)),state:'prepared'};atomic(path,record)
   }
   const outcome=(state,extra={})=>({op:body.op,state,confirmed:state==='confirmed',directory:record.directory,headDigest:body.nextHead.digest,...(record.historyDirectory?{historyDirectory:record.historyDirectory,historyDigest:record.historyDigest}:{}),servicesChanged:false,...extra})
   const matches=status=>status.accepted&&status.op===body.op&&status.receiptHash===record.receiptHash&&status.headDigest===body.nextHead.digest&&status.sourceHolder===body.holder&&status.sourceTerm===body.term&&status.target===target
   const confirm=status=>{if(!matches(status))throw Error('authority receipt conflicts with verified candidate');record.state='confirmed';atomic(path,record);return outcome('confirmed',{replayed:true})}
   let status
   try{status=await authority.request('/sync/status',{op:body.op})}catch{return outcome('receipt-unknown',{needsStatus:true})}
   if(typeof status?.accepted!=='boolean'||status.op!==body.op)throw Error('invalid authority receipt status')
   if(status.accepted)return confirm(status)
   if(record.state==='confirmed')throw Error('authority lost an already acknowledged receipt; stop')
   if(record.state==='rejected')return outcome('rejected')
   if(record.state==='submitted'&&!retryUnaccepted)return outcome('receipt-unknown',{needsStatus:true})
   // The HTTP check is a read, not a remote transaction. The final receipt acceptance is fenced on server.
   await checkAuthority();await validateCandidate(record,body,packet)
   record.state='submitted';atomic(path,record)
   try{
    const accepted=await authority.request('/sync/receipt',{receipt:record.receipt})
    if(accepted.op!==body.op||accepted.receiptHash!==record.receiptHash)throw Error('unknown receipt response')
    record.state='confirmed';atomic(path,record);return outcome('confirmed',{replayed:accepted.replayed})
   }catch(error){
    if([400,401,403,409,423].includes(error.status)){record.state='rejected';atomic(path,record);return outcome('rejected',{httpStatus:error.status})}
    let found;try{found=await authority.request('/sync/status',{op:body.op})}catch{}
    if(found?.accepted)return confirm(found)
    return outcome('receipt-unknown',{needsStatus:true})
   }
  })
 }
 return Object.freeze({receive,status(op){if(typeof op!=='string'||!op||op.length>160)throw Error('bounded materializer operation required');const path=privateFile('receipt-'+sha(op)+'.json');if(!existsSync(path))return {op,state:'absent'};const r=read(path);return {op,state:r.state,headDigest:r.headDigest,receiptHash:r.receiptHash}}})
}
