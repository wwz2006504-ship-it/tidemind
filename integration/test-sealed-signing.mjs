import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {createStateTransferFixture,secret} from './state-transfer-fixture.mjs'
import {authorityHttpFixture,keys} from './authority-http-fixture.mjs'
import {signSyncReceipt} from './sync-receipts.mjs'
import {receiveSyntheticState} from './state-transfer-receiver.mjs'
import {prepareSyncDeltaBody,authenticateSyncDelta,describeSealedDelta} from './sync-delta.mjs'
const ack=h=>({revision:h.sqlite.revision,hash:h.sqlite.hash,data_hash:h.sqlite.dataHash,baseline_hash:h.sqlite.baseline,protected_hash:h.sqlite.protectedHash,composite:h})
async function setup(){
 const f=await createStateTransferFixture();let n;const previous=process.env.TIDEMIND_SYNC_SIGNING_KEY;process.env.TIDEMIND_SYNC_SIGNING_KEY=secret
 try{n=await authorityHttpFixture({storageFixture:f});const root=join(f.root,'initial-cloud');mkdirSync(root);await receiveSyntheticState({root,capsule:f.capsule,authority:n.cloud})
 const a=ack(f.next.head),op='sign-forward'
 await n.local.request('/transfer/begin',{op,term:f.term,target:'cloud',baseDigest:f.base.head.digest,sourceAck:a})
 await n.local.request('/transfer/confirm',{term:f.term,ticketId:op,receiptOp:f.capsule.packet.op,sourceAck:a})
 await n.local.request('/transfer/pause',{op,term:f.term});await n.local.request('/transfer/freeze',{op,term:f.term});await n.local.request('/transfer/seal',{op,term:f.term,head:f.next.head})
 await n.local.request('/transfer/handover',{op,ticketId:op,target:'cloud',term:f.term,expectedRevision:a.revision,expectedHash:a.hash,sourceAck:a,targetAck:a})
 const grant=await n.cloud.request('/admin',{command:'acquire'}),ticketId='sign-return',body=prepareSyncDeltaBody({baseDirectory:f.base.directory,nextDirectory:f.next.directory,baseHead:f.base.head,nextHead:f.next.head,op:ticketId,holder:'cloud',term:grant.term,target:'local',mode:'handover'})
 await n.cloud.request('/transfer/begin',{op:ticketId,term:grant.term,target:'local',baseDigest:f.base.head.digest,sourceAck:a})
 const freeze=async()=>{await n.cloud.request('/transfer/pause',{op:ticketId,term:grant.term});await n.cloud.request('/transfer/freeze',{op:ticketId,term:grant.term});await n.cloud.request('/transfer/seal',{op:ticketId,term:grant.term,head:f.next.head})}
 return {...f,n,body,ticketId,grant,freeze,cleanup:async()=>{await n.cleanup();f.cleanup();if(previous===undefined)delete process.env.TIDEMIND_SYNC_SIGNING_KEY;else process.env.TIDEMIND_SYNC_SIGNING_KEY=previous}}
 }catch(e){if(n)await n.cleanup();f.cleanup();if(previous===undefined)delete process.env.TIDEMIND_SYNC_SIGNING_KEY;else process.env.TIDEMIND_SYNC_SIGNING_KEY=previous;throw e}
}
test('remote signer rejects open source and wrong principal, then deterministically signs only sealed reverse intent',async()=>{const f=await setup();try{const request={ticketId:f.ticketId,descriptor:describeSealedDelta(f.body)};await assert.rejects(f.n.cloud.request('/sync/sign',request),e=>e.status===409);await f.freeze();await assert.rejects(f.n.local.request('/sync/sign',request),e=>e.status===409);const signed=await f.n.cloud.request('/sync/sign',request);assert.deepEqual(authenticateSyncDelta({...f.body,...signed},secret),f.body);assert.deepEqual(await f.n.cloud.request('/sync/sign',request),signed);assert.equal(f.gateway.head(f.lease).home,'cloud');assert.equal(f.lease.status().term,f.grant.term)}finally{await f.cleanup()}})
test('sealed reverse signer rejects missing intent, old term, malformed patch and unresolved outgoing event',async()=>{const f=await setup();try{await f.freeze();const request={ticketId:f.ticketId,descriptor:describeSealedDelta(f.body)};for(const bad of [{...request,ticketId:'missing'},{...request,descriptor:{...describeSealedDelta(f.body),term:f.term}},{...request,descriptor:{...describeSealedDelta(f.body),bodyDigest:'bad'}}])await assert.rejects(f.n.cloud.request('/sync/sign',bad),e=>e.status===409)
 f.lease.fenced('cloud',f.grant.term,db=>db.prepare("INSERT INTO tide_outbox VALUES('unknown-sign','hash','synthetic','cloud',?,'unknown','attempt',NULL)").run(f.grant.term));await assert.rejects(f.n.cloud.request('/sync/sign',request),e=>e.status===409)
 assert.equal(f.gateway.head(f.lease).home,'cloud')
 }finally{await f.cleanup()}})
test('same signing operation cannot bind different bytes; packet tampering fails authentication',async()=>{const f=await setup();try{await f.freeze();const descriptor=describeSealedDelta(f.body),proof=await f.n.cloud.request('/sync/sign',{ticketId:f.ticketId,descriptor})
 await assert.rejects(f.n.cloud.request('/sync/sign',{ticketId:f.ticketId,descriptor:{...descriptor,bodyDigest:'a'.repeat(64)}}),e=>e.status===409)
 const packet={...structuredClone(f.body),...proof};packet.files['ledger.jsonl'].insert='eA==';assert.throws(()=>authenticateSyncDelta(packet,secret),/signature invalid/)
 }finally{await f.cleanup()}})
test('resuming sealed memory revokes both source checks and final receipt acceptance even at same SQL revision',async()=>{const f=await setup();try{await f.freeze();const proof=await f.n.cloud.request('/sync/sign',{ticketId:f.ticketId,descriptor:describeSealedDelta(f.body)}),check={op:f.ticketId,holder:'cloud',term:f.grant.term,target:'local',mode:'handover',baseDigest:f.body.baseHead.digest,head:f.body.nextHead,ticketId:f.ticketId,sealed:true}
 assert.equal((await f.n.local.request('/sync/check',check)).authorized,true)
 await f.n.cloud.request('/transfer/resume',{op:f.ticketId,term:f.grant.term})
 await assert.rejects(f.n.local.request('/sync/check',check),e=>e.status===409)
 const receipt=signSyncReceipt({op:f.ticketId,sourceHolder:'cloud',sourceTerm:f.grant.term,target:'local',baseDigest:f.body.baseHead.digest,packetSignature:proof.signature,ack:ack(f.next.head)},keys.local)
 await assert.rejects(f.n.local.request('/sync/receipt',{receipt}),e=>e.status===409);assert.equal((await f.n.local.request('/sync/status',{op:f.ticketId})).accepted,false)
 }finally{await f.cleanup()}})
