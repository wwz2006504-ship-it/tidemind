import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {createWindowsRoundtrip,createCloudRoundtrip} from './roundtrip-fixture.mjs'
for(const faults of [false,true])test('one authority: local history -> cloud NEW four-store records -> local resume'+(faults?' with lost responses':''),async()=>{
 const local=await createWindowsRoundtrip();try{
  const root=join(local.root,'physical-cloud-fixture');mkdirSync(root);const cloud=await createCloudRoundtrip({root,capsule:local.capsule,authority:local.network.cloud})
  await local.releaseForward(cloud.forward);const outbound=await cloud.advance({loseSigningResponse:faults});assert.equal(outbound.sourceWritesBlocked,true)
  const received=await local.receiveReturn(outbound,{loseReceiptResponse:faults});assert.equal(received.receiptSubmissions,1)
  const released=await cloud.finish(received,{loseHandoverResponse:faults});assert.equal(released.wrongAckRejected,true);assert.equal(released.oldCloudWriteRejected,true)
  const result=await local.activateReturned();assert.equal(result.cloudNewWriteMerged,true);assert.deepEqual(result.termSequence,[1,2,3]);assert.deepEqual(result.finalRevisions,{sqlite:3,json:3,persona:3,aiMemory:3})
 }finally{await local.cleanup()}
})
