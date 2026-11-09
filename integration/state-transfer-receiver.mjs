import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createMaterializerWorker} from './materializer-worker.mjs'
import {keys} from './authority-http-fixture.mjs'
import {setupOriginals,slots,secret,sha} from './state-transfer-fixture.mjs'
export async function receiveSyntheticState({root,capsule,authority,loseReceiptResponse=false,returnDirectory=false}){
 if(capsule?.format!=='synthetic-four-adapter-capsule-v1'||JSON.stringify(capsule).length>2*1024*1024||JSON.stringify(Object.keys(capsule.baseFiles).sort())!==JSON.stringify([...slots].sort()))throw Error('bounded synthetic capsule required')
 const {verify}=setupOriginals(root),base=join(root,'base'),stage=join(root,'incoming'),journal=join(root,'journal'),broken=join(root,'corrupt-base')
 for(const p of [base,stage,journal,broken])mkdirSync(p)
 for(const n of slots){const bytes=Buffer.from(capsule.baseFiles[n],'base64');writeFileSync(join(base,n),bytes);writeFileSync(join(broken,n),bytes)}
 assert.equal(verify(base).digest,capsule.baseHead.digest)
 const original=Object.fromEntries(slots.map(n=>[n,sha(readFileSync(join(base,n)))]));let submissions=0,checks=0
 let lost=false
 const transport={request:async(path,body)=>{if(path==='/sync/receipt')submissions++;const response=await authority.request(path,body);if(path==='/sync/receipt'&&loseReceiptResponse&&!lost){lost=true;throw Error('SYNTHETIC RESPONSE LOST AFTER ACCEPTANCE')}return response}}
 const worker=createMaterializerWorker({target:'cloud',authority:transport,secret,materializerKey:keys.cloud,journalDirectory:journal,stagingDirectory:stage,verifyGeneration:verify})
 const args={packet:capsule.packet,baseDirectory:base,expectedBase:capsule.baseHead}
 const tampered=structuredClone(capsule.packet);tampered.files['ledger.jsonl'].insert='eA=='
 await assert.rejects(worker.receive({...args,packet:tampered}),/signature invalid/);checks++
 await assert.rejects(worker.receive({...args,expectedBase:capsule.nextHead}),/target base differs/);checks++
 writeFileSync(join(broken,'ledger.jsonl'),'SYNTHETIC CORRUPTION')
 await assert.rejects(worker.receive({...args,baseDirectory:broken}));checks++
 assert.deepEqual(readdirSync(stage),[]);assert.deepEqual(readdirSync(journal),[])
 assert.equal((await worker.receive({...args,dryRun:true})).dryRun,true);assert.deepEqual(readdirSync(stage),[]);assert.deepEqual(readdirSync(journal),[]);checks++
 const received=await worker.receive(args);assert.equal(received.confirmed,true);assert.equal(verify(received.directory).digest,capsule.nextHead.digest);checks++
 const again=await worker.receive(args);assert.equal(again.confirmed,true);assert.equal(submissions,1);checks++
 await assert.rejects(worker.receive({...args,packet:capsule.conflictPacket,baseDirectory:received.directory,expectedBase:capsule.nextHead}),/target base differs/);checks++
 if(loseReceiptResponse){assert.equal(lost,true);checks++}
 const returnedFiles={}
 for(const n of slots){const bytes=readFileSync(join(received.directory,n));assert.equal(sha(bytes),capsule.packet.files[n].after);assert.equal(sha(readFileSync(join(base,n))),original[n]);returnedFiles[n]=bytes.toString('base64')}
 return {passed:true,checks,receiptSubmissions:submissions,receiptResponseLossInjected:lost,headDigest:received.headDigest,returnedFiles,baseUnchanged:true,newerCandidatePreserved:true,...(returnDirectory?{directory:received.directory}:{}),scope:'cross-machine forward materialization and immutable return verification; not cloud-new-write merge'}
}
