// Durable materializer receipts and two-phase transfer intents in the EXISTING authority database.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto'
import {assertCompositeAgreement} from './composite-head.mjs'
import {assertSealedDeltaGrant} from './sync-delta.mjs'
import {assertHistoryAckAgreement} from './session-history-authority.mjs'
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v
const canonical=v=>JSON.stringify(ordered(v)),hash=v=>createHash('sha256').update(canonical(v)).digest('hex')
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const id=v=>{if(typeof v!=='string'||!v||v.length>160)throw Error('bounded operation identity required')}
function validate(body){id(body.op);if(!['local','cloud'].includes(body.sourceHolder)||!['local','cloud'].includes(body.target)||body.target===body.sourceHolder||!Number.isSafeInteger(body.sourceTerm)||body.sourceTerm<1||!hex(body.baseDigest)||!hex(body.packetSignature))throw Error('invalid sync receipt identity');assertCompositeAgreement(body.ack,body.ack,{required:true})}
function mac(body,key){if(typeof key!=='string'||key.length<32)throw Error('private materializer key required');return createHmac('sha256',key).update(canonical(body)).digest('hex')}
export function signSyncReceipt(body,key){validate(body);return {...body,proof:mac(body,key)}}
function assertHead(db,holder,ack){const h=db.prepare('SELECT * FROM tide_head').get();if(h.home!==holder||h.revision!==ack.revision||h.hash!==ack.hash||h.baseline_hash!==ack.baseline_hash||h.protected_hash!==ack.protected_hash)throw Error('source authority advanced or changed')}
export function createSyncReceipts({lease,materializerKeys}){
 if(!materializerKeys||materializerKeys.local===materializerKeys.cloud)throw Error('distinct materializer keys required')
 for(const home of ['local','cloud'])mac({},materializerKeys[home])
 const fence=(holder,term,fn)=>lease.fenced(holder,term,fn)
 function accept(receipt){
  const {proof,...body}=receipt;validate(body);const expected=mac(body,materializerKeys[body.target])
  if(!hex(proof)||!timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(expected,'hex')))throw Error('materializer receipt signature invalid')
  return fence(body.sourceHolder,body.sourceTerm,db=>{assertHead(db,body.sourceHolder,body.ack);assertHistoryAckAgreement(db,{sourceAck:body.ack,targetAck:body.ack,holder:body.sourceHolder,term:body.sourceTerm,op:body.op});assertSealedDeltaGrant(db,{op:body.op,holder:body.sourceHolder,term:body.sourceTerm,target:body.target,baseDigest:body.baseDigest,headDigest:body.ack.composite.digest,packetSignature:body.packetSignature});const signature=hash(body),old=db.prepare('SELECT * FROM tide_sync_receipts WHERE op=?').get(body.op)
   if(old){if(old.signature!==signature)throw Error('sync receipt conflict');return {op:body.op,receiptHash:signature,replayed:true}}
   db.prepare('INSERT INTO tide_sync_receipts VALUES(?,?,?)').run(body.op,signature,canonical(body));return {op:body.op,receiptHash:signature,replayed:false}
  })
 }
 function begin({holder,term,op,target,baseDigest,sourceAck}){
  id(op);if(!['local','cloud'].includes(target)||target===holder||!hex(baseDigest))throw Error('invalid transfer intent')
  assertCompositeAgreement(sourceAck,sourceAck,{required:true})
  return fence(holder,term,db=>{assertHead(db,holder,sourceAck);assertHistoryAckAgreement(db,{sourceAck,targetAck:sourceAck,holder,term,op});const body={op,holder,term,target,baseDigest,headDigest:sourceAck.composite.digest,sourceAck},signature=hash(body),old=db.prepare('SELECT * FROM tide_transfer_tickets WHERE op=?').get(op)
   if(old){if(old.signature!==signature)throw Error('transfer intent conflict');return {ticketId:op,state:old.state,replayed:true}}
   db.prepare("INSERT INTO tide_transfer_tickets VALUES(?,?,?,'intent',NULL,NULL)").run(op,signature,canonical(body));return {ticketId:op,state:'intent',replayed:false}
  })
 }
 function authorizeReverse({ticketId,holder,term,target,baseDigest,nextDigest}){
  id(ticketId);return fence(holder,term,db=>{const row=db.prepare('SELECT * FROM tide_transfer_tickets WHERE op=?').get(ticketId);if(!row||!['intent','ready'].includes(row.state))throw Error('reviewed transfer intent missing');const body=JSON.parse(row.body)
   if(hash(body)!==row.signature||holder!=='cloud'||target!=='local'||body.holder!==holder||body.term!==term||body.target!==target||body.baseDigest!==baseDigest||body.headDigest!==nextDigest)throw Error('reverse transfer intent mismatch');assertHead(db,holder,body.sourceAck);return {authorized:true,ticketId}
  })
 }
 function confirm({holder,term,ticketId,receiptOp,sourceAck}){
  id(ticketId);id(receiptOp);return fence(holder,term,db=>{const ticket=db.prepare('SELECT * FROM tide_transfer_tickets WHERE op=?').get(ticketId),receipt=db.prepare('SELECT * FROM tide_sync_receipts WHERE op=?').get(receiptOp)
   if(!ticket||!receipt||!['intent','ready'].includes(ticket.state))throw Error('transfer intent or receipt missing')
   const body=JSON.parse(ticket.body),received=JSON.parse(receipt.body)
   if(hash(body)!==ticket.signature||hash(received)!==receipt.signature||body.holder!==holder||body.term!==term||received.sourceHolder!==holder||received.sourceTerm!==term||received.target!==body.target||received.baseDigest!==body.baseDigest||body.headDigest!==sourceAck?.composite?.digest)throw Error('transfer proof mismatch')
   assertHead(db,holder,sourceAck);assertCompositeAgreement(sourceAck,received.ack,{required:true})
   assertHistoryAckAgreement(db,{sourceAck,targetAck:received.ack,holder,term,op:ticketId})
   if(ticket.state==='ready'){if(ticket.receipt_op!==receiptOp||ticket.receipt_hash!==receipt.signature)throw Error('transfer confirmation conflict');return {ticketId,state:'ready',replayed:true}}
   db.prepare("UPDATE tide_transfer_tickets SET state='ready',receipt_op=?,receipt_hash=? WHERE op=?").run(receiptOp,receipt.signature,ticketId);return {ticketId,state:'ready',replayed:false}
  })
 }
 function status({principal,op}){id(op);if(!['local','cloud'].includes(principal))throw Error('authenticated principal required');const db=lease.openAuthority();try{const row=db.prepare('SELECT * FROM tide_sync_receipts WHERE op=?').get(op);if(!row)return {accepted:false,op};const body=JSON.parse(row.body);if(hash(body)!==row.signature||![body.sourceHolder,body.target].includes(principal))throw Error('receipt status rejected');return {accepted:true,op,receiptHash:row.signature,sourceHolder:body.sourceHolder,sourceTerm:body.sourceTerm,target:body.target,headDigest:body.ack.composite.digest}}finally{db.close()}}
 function checkSource({principal,holder,term,target,mode,baseDigest,head,historyHead,ticketId,op,sealed=false}){
  if(principal!==target||!['local','cloud'].includes(target)||!hex(baseDigest))throw Error('authenticated receiving principal required')
  const s=head?.sqlite,ack={revision:s?.revision,hash:s?.hash,data_hash:s?.dataHash,baseline_hash:s?.baseline,protected_hash:s?.protectedHash,composite:head,...(historyHead?{history:historyHead}:{})};assertCompositeAgreement(ack,ack,{required:true})
  return fence(holder,term,db=>{assertHead(db,holder,ack)
   assertHistoryAckAgreement(db,{sourceAck:ack,targetAck:ack,holder,term,op})
   if(op){const found=assertSealedDeltaGrant(db,{op,holder,term,target,baseDigest,headDigest:head.digest});if(sealed&&!found)throw Error('sealed signature grant absent')}
   else if(sealed)throw Error('sealed signature operation required')
   if(!(mode==='replicate'&&holder==='local'&&target==='cloud')){
    if(mode!=='handover')throw Error('reverse requires handover intent')
    authorizeReverse({ticketId,holder,term,target,baseDigest,nextDigest:head.digest})
   }
   return {authorized:true,holder,term,target,headDigest:head.digest,...(historyHead?{historyDigest:historyHead.digest}:{})}
  })
 }
 return Object.freeze({accept,begin,authorizeReverse,confirm,status,checkSource})
}
export function consumeHandoverTicket(db,{ticketId,op,holder,term,target,sourceAck,targetAck}){
 id(ticketId);if(ticketId!==op)throw Error('handover operation differs from reviewed ticket')
 const ticket=db.prepare('SELECT * FROM tide_transfer_tickets WHERE op=?').get(ticketId)
 if(!ticket||ticket.state!=='ready')throw Error('ready handover ticket required')
 const body=JSON.parse(ticket.body),receipt=db.prepare('SELECT * FROM tide_sync_receipts WHERE op=?').get(ticket.receipt_op)
 if(!receipt)throw Error('durable materializer receipt missing')
 const received=JSON.parse(receipt.body)
 if(hash(body)!==ticket.signature||hash(received)!==receipt.signature||receipt.signature!==ticket.receipt_hash||body.holder!==holder||body.term!==term||body.target!==target||body.headDigest!==sourceAck?.composite?.digest||received.target!==target||received.sourceHolder!==holder||received.sourceTerm!==term||received.baseDigest!==body.baseDigest)throw Error('handover ticket or receipt mismatch')
 assertCompositeAgreement(sourceAck,targetAck,{required:true});assertCompositeAgreement(targetAck,received.ack,{required:true})
 assertHistoryAckAgreement(db,{sourceAck:body.sourceAck,targetAck:received.ack,holder,term,op})
 db.prepare("UPDATE tide_transfer_tickets SET state='consumed' WHERE op=?").run(ticketId)
}
