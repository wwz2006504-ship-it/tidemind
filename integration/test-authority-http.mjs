import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {createAuthorityClient} from './authority-client.mjs'
import {signSyncReceipt} from './sync-receipts.mjs'
import {authorityHttpFixture as setup,keys,tokens} from './authority-http-fixture.mjs'
const h='a'.repeat(64)

test('existing HTTP authority authenticates receiver, persists receipt and commits ticketed handover',async()=>{
 const f=await setup();try{
  const intent={op:'http-transfer',term:f.term,target:'cloud',baseDigest:f.ack.composite.digest,sourceAck:f.ack}
  assert.equal((await f.local.request('/transfer/begin',intent)).state,'intent')
  await assert.rejects(f.local.request('/transfer/confirm',{term:f.term,ticketId:intent.op,receiptOp:'missing',sourceAck:f.ack}),e=>e.status===409)
  const receipt=signSyncReceipt({op:'http-receipt',sourceHolder:'local',sourceTerm:f.term,target:'cloud',baseDigest:f.ack.composite.digest,packetSignature:h,ack:f.ack},keys.cloud)
  await assert.rejects(f.local.request('/sync/receipt',{receipt}),e=>e.status===403)
  assert.equal((await f.cloud.request('/sync/receipt',{receipt})).replayed,false);assert.equal((await f.cloud.request('/sync/receipt',{receipt})).replayed,true)
  await assert.rejects(f.cloud.request('/transfer/confirm',{term:f.term,ticketId:intent.op,receiptOp:receipt.op,sourceAck:f.ack}),e=>e.status===409)
  await f.local.request('/transfer/confirm',{term:f.term,ticketId:intent.op,receiptOp:receipt.op,sourceAck:f.ack})
  await f.local.request('/transfer/pause',{op:intent.op,term:f.term})
  await f.local.request('/transfer/freeze',{op:intent.op,term:f.term})
  await f.local.request('/transfer/seal',{op:intent.op,term:f.term,head:f.ack.composite})
  const result=await f.local.request('/transfer/handover',{op:intent.op,ticketId:intent.op,target:'cloud',term:f.term,expectedRevision:0,expectedHash:'GENESIS',sourceAck:f.ack,targetAck:f.ack});assert.equal(result.target,'cloud')
  const grant=await f.cloud.request('/admin',{command:'acquire'});assert.ok(grant.term>f.term);assert.equal((await f.local.request('/admin',{command:'renew',term:f.term})).ok,false)
  assert.equal((await f.cloud.request('/sync/status',{op:receipt.op})).accepted,true);assert.equal((await f.local.request('/sync/status',{op:receipt.op})).headDigest,f.ack.composite.digest)
  const reverse={op:'http-return',term:grant.term,target:'local',baseDigest:f.ack.composite.digest,sourceAck:f.ack}
  await assert.rejects(f.local.request('/transfer/begin',{...reverse,holder:'cloud'}),e=>e.status===409)
  await f.cloud.request('/transfer/begin',reverse)
  const proof={ticketId:reverse.op,holder:'cloud',term:grant.term,target:'local',baseDigest:f.ack.composite.digest,nextDigest:f.ack.composite.digest}
  assert.equal((await f.local.request('/transfer/authorize',proof)).authorized,true)
  await assert.rejects(f.local.request('/transfer/authorize',{...proof,term:f.term}),e=>e.status===409)

 }finally{await f.cleanup()}
})
test('missing keys, installation standby and invalid principal block network transfer actions',async()=>{
 for(const mode of [{withKeys:false},{standby:true}]){const f=await setup(mode);try{await assert.rejects(f.local.request('/transfer/begin',{op:'blocked'}),e=>e.status===423);assert.equal((await f.local.request('/admin',{command:'status'})).holder,'local');const bad=createAuthorityClient({url:f.url,token:'SYNTHETIC_WRONG_TOKEN_123456789'});await assert.rejects(bad.request('/head'),e=>e.status===401);assert.equal(f.gateway.head(f.lease).home,'local')}finally{await f.cleanup()}}
})
test('private tunnel client refuses remote URLs and never forwards bearer token across redirects',async()=>{
 assert.throws(()=>createAuthorityClient({url:'http://example.com:5181/',token:tokens.local}),/loopback/);assert.throws(()=>createAuthorityClient({url:'http://127.0.0.1:5181/path',token:tokens.local}),/loopback/)
 let forwarded=0;const target=http.createServer((req,res)=>{forwarded++;res.end('{}')});target.listen(0,'127.0.0.1');await new Promise(r=>target.once('listening',r));const redirect=http.createServer((req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:'+target.address().port+'/'});res.end()});redirect.listen(0,'127.0.0.1');await new Promise(r=>redirect.once('listening',r))
 try{const client=createAuthorityClient({url:'http://127.0.0.1:'+redirect.address().port+'/',token:tokens.local});await assert.rejects(client.request('/head'),e=>e.status===302);assert.equal(forwarded,0);await assert.rejects(client.request('/unreviewed'),/unknown/)}finally{redirect.closeAllConnections();target.closeAllConnections();await Promise.all([new Promise(r=>redirect.close(r)),new Promise(r=>target.close(r))])}
})
