// Trusted local signer proof cannot be supplied by model-generated fields.
import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {prepareStoreOperation} from './store-adapter.mjs'

test('tampered original-store batch is rejected before journal acceptance',async()=>{
 const f=await fixture();try{
  const plan=await prepareStoreOperation(f.local,{method:'write',args:[{layer:'episodic',content:'合成已验证内容'}]})
  plan.batch.after='a'.repeat(64)
  assert.throws(()=>f.gateway.commit(f.lease,'local',f.term,{op:'forged',expectedRevision:0,expectedHash:'GENESIS',mutation:plan.batch}),/unverified/)
  assert.equal(f.gateway.head(f.lease).revision,0)
 }finally{f.cleanup()}
})

test('captured signed batch cannot be rebound to a new operation or revision',async()=>{
 const f=await fixture();try{
  const {executeStoreOperation}=await import('./store-adapter.mjs')
  await executeStoreOperation({gateway:f.gateway,lease:f.lease,holder:'local',term:f.term,srcDbPath:f.local,
   operation:{method:'write',args:[{layer:'episodic',content:'合成签名绑定内容'}]},op:'original-op',expectedRevision:0,expectedHash:'GENESIS'})
  const old=f.gateway.committedSince(f.lease)[0],h=f.gateway.head(f.lease)
  assert.throws(()=>f.gateway.commit(f.lease,'local',f.term,{op:'rebound-op',expectedRevision:h.revision,expectedHash:h.hash,mutation:old.mutation}),/bound to another commit/)
  assert.equal(f.gateway.head(f.lease).revision,1)
 }finally{f.cleanup()}
})
