import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createStateTransferFixture,slots,sha} from './state-transfer-fixture.mjs'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {receiveSyntheticState} from './state-transfer-receiver.mjs'
test('four actual protected adapters produce a portable signed SQLite+sidecar delta and exact return bytes',async()=>{
 const f=await createStateTransferFixture();let network;try{network=await authorityHttpFixture({storageFixture:f});const root=join(f.root,'receiver');mkdirSync(root)
 const result=await receiveSyntheticState({root,capsule:f.capsule,authority:network.cloud});assert.equal(result.passed,true);assert.equal(result.checks,7);assert.equal(result.receiptSubmissions,1);assert.equal(result.newerCandidatePreserved,true)
 for(const n of slots)assert.equal(sha(Buffer.from(result.returnedFiles[n],'base64')),sha(readFileSync(join(f.next.directory,n))))
 assert.equal(f.next.head.sqlite.revision,1);for(const k of ['json','persona','aiMemory'])assert.equal(f.next.head[k].revision,2);f.assertOriginals()
 }finally{if(network)await network.cleanup();f.cleanup()}
})
test('real four-adapter transfer recovers lost receipt response by status without resubmission',async()=>{
 const f=await createStateTransferFixture();let network;try{network=await authorityHttpFixture({storageFixture:f});const root=join(f.root,'lost-response-receiver');mkdirSync(root)
 const result=await receiveSyntheticState({root,capsule:f.capsule,authority:network.cloud,loseReceiptResponse:true});assert.equal(result.passed,true);assert.equal(result.checks,8);assert.equal(result.receiptSubmissions,1);assert.equal(result.receiptResponseLossInjected,true);f.assertOriginals()
 }finally{if(network)await network.cleanup();f.cleanup()}
})
