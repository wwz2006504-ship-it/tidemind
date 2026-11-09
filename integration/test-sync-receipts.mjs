import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {createCompositeHead} from './composite-head.mjs'
import {createSyncReceipts,signSyncReceipt} from './sync-receipts.mjs'
const h='a'.repeat(64),keys={local:'SYNTHETIC LOCAL MATERIALIZER KEY LONG 1234',cloud:'SYNTHETIC CLOUD MATERIALIZER KEY LONG 5678'}
async function setup(){const f=await fixture(),sqlite=f.replica.replicaHead(f.local),composite=createCompositeHead({sqlite,jsonMemory:{overlayRevision:0,overlayHash:h,baselineSha256:h},persona:{overlayVersion:0,currentHash:h,sha256:h},aiMemory:{revision:0,hash:h,baseline:h}}),ack={...sqlite,composite}
 const receipts=createSyncReceipts({lease:f.lease,materializerKeys:keys}),body={op:'receive-op',sourceHolder:'local',sourceTerm:f.term,target:'cloud',baseDigest:composite.digest,packetSignature:h,ack},intent={holder:'local',term:f.term,op:'transfer-op',target:'cloud',baseDigest:composite.digest,sourceAck:ack}
 const row=(table,op)=>{const db=f.lease.openAuthority();try{return db.prepare('SELECT * FROM '+table+' WHERE op=?').get(op)}finally{db.close()}}
 return {...f,ack,body,intent,receipts,row}
}
test('target-signed receipt persists, is replayable after reopening, and rejects tampering or operation conflict',async()=>{const f=await setup();try{const signed=signSyncReceipt(f.body,keys.cloud);assert.equal(f.receipts.accept(signed).replayed,false);const fresh=createSyncReceipts({lease:f.lease,materializerKeys:keys});assert.equal(fresh.accept(signed).replayed,true)
 assert.throws(()=>fresh.accept({...signed,baseDigest:h}),/signature invalid/);assert.throws(()=>fresh.accept(signSyncReceipt({...f.body,packetSignature:'b'.repeat(64)},keys.cloud)),/receipt conflict/);assert.throws(()=>fresh.accept(signSyncReceipt({...f.body,op:'wrong-key'},keys.local)),/signature invalid/)
 }finally{f.cleanup()}})
test('missing durable receipt cannot confirm a transfer, and old source lease cannot admit receipts',async()=>{const f=await setup();try{f.receipts.begin(f.intent);assert.throws(()=>f.receipts.confirm({holder:'local',term:f.term,ticketId:f.intent.op,receiptOp:'absent',sourceAck:f.ack}),/missing/);assert.equal(f.row('tide_transfer_tickets',f.intent.op).state,'intent');f.lease.release('local',f.term);assert.throws(()=>f.receipts.accept(signSyncReceipt(f.body,keys.cloud)));assert.equal(f.row('tide_sync_receipts',f.body.op),undefined)}finally{f.cleanup()}})
test('existing gateway consumes ready ticket with home change and lease release in one transaction',async()=>{const f=await setup();const prior=process.env.TIDEMIND_REQUIRE_HANDOVER_TICKET;try{process.env.TIDEMIND_REQUIRE_HANDOVER_TICKET='1';const args={op:f.intent.op,target:'cloud',expectedRevision:0,expectedHash:'GENESIS',sourceAck:f.ack,targetAck:f.ack,ticketId:f.intent.op}
 assert.throws(()=>f.gateway.handover(f.lease,'local',f.term,args),/ready handover ticket/);assert.equal(f.lease.status().holder,'local')
 assert.equal(f.receipts.begin(f.intent).state,'intent');f.receipts.accept(signSyncReceipt(f.body,keys.cloud));assert.equal(f.receipts.confirm({holder:'local',term:f.term,ticketId:f.intent.op,receiptOp:f.body.op,sourceAck:f.ack}).state,'ready')
 assert.equal(f.gateway.handover(f.lease,'local',f.term,args).target,'cloud');assert.equal(f.row('tide_transfer_tickets',f.intent.op).state,'consumed');assert.equal(f.lease.status().holder,null);assert.equal(f.gateway.head(f.lease).home,'cloud');const next=f.lease.acquire('cloud',{ttl:60000});assert.ok(next.term>f.term);assert.equal(f.lease.renew('local',f.term).ok,false)
 }finally{if(prior===undefined)delete process.env.TIDEMIND_REQUIRE_HANDOVER_TICKET;else process.env.TIDEMIND_REQUIRE_HANDOVER_TICKET=prior;f.cleanup()}})
test('unresolved outgoing delivery rolls back ticket consumption and preserves current primary',async()=>{const f=await setup();try{f.receipts.begin(f.intent);f.receipts.accept(signSyncReceipt(f.body,keys.cloud));f.receipts.confirm({holder:'local',term:f.term,ticketId:f.intent.op,receiptOp:f.body.op,sourceAck:f.ack})
 f.lease.fenced('local',f.term,db=>db.prepare("INSERT INTO tide_outbox(event_key,payload_hash,payload,holder,term,state) VALUES('synthetic-unknown','hash','{}','local',?,'unknown')").run(f.term))
 assert.throws(()=>f.gateway.handover(f.lease,'local',f.term,{op:f.intent.op,target:'cloud',expectedRevision:0,expectedHash:'GENESIS',sourceAck:f.ack,targetAck:f.ack,ticketId:f.intent.op}),/unresolved outgoing/)
 assert.equal(f.row('tide_transfer_tickets',f.intent.op).state,'ready');assert.equal(f.lease.status().holder,'local');assert.equal(f.gateway.head(f.lease).home,'local')
 }finally{f.cleanup()}})
test('reverse synchronization requires persisted matching cloud-to-local intent',async()=>{const f=await setup();try{f.lease.release('local',f.term);const term=f.lease.acquire('cloud',{ttl:60000}).term;f.gateway.takeover(f.lease,'cloud',term,{expectedRevision:0,expectedHash:'GENESIS',targetAck:f.ack,expectedComposite:f.ack.composite})
 const proof={ticketId:'return-local',holder:'cloud',term,target:'local',baseDigest:f.ack.composite.digest,nextDigest:f.ack.composite.digest};assert.throws(()=>f.receipts.authorizeReverse(proof),/intent missing/)
 f.receipts.begin({holder:'cloud',term,op:proof.ticketId,target:'local',baseDigest:proof.baseDigest,sourceAck:f.ack});assert.equal(f.receipts.authorizeReverse(proof).authorized,true);assert.throws(()=>f.receipts.authorizeReverse({...proof,nextDigest:h}),/mismatch/);assert.throws(()=>f.receipts.authorizeReverse({...proof,term:term-1}))
 }finally{f.cleanup()}})

test('a receipt for an older JSON history cannot confirm a newer source composite even at same SQLite revision',async()=>{
 const f=await setup();try{f.receipts.begin(f.intent);f.receipts.accept(signSyncReceipt(f.body,keys.cloud));const changed=createCompositeHead({sqlite:f.ack,jsonMemory:{overlayRevision:1,overlayHash:'b'.repeat(64),baselineSha256:h},persona:{overlayVersion:0,currentHash:h,sha256:h},aiMemory:{revision:0,hash:h,baseline:h}})
 assert.throws(()=>f.receipts.confirm({holder:'local',term:f.term,ticketId:f.intent.op,receiptOp:f.body.op,sourceAck:{...f.ack,composite:changed}}),/transfer proof mismatch/);assert.equal(f.row('tide_transfer_tickets',f.intent.op).state,'intent');assert.equal(f.gateway.head(f.lease).home,'local')
 }finally{f.cleanup()}
})
