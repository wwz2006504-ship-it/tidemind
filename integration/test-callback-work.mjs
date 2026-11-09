import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createCallbackWork} from './callback-work.mjs'
test('sync callbacks retain values and async callbacks remain visible until settled',async()=>{
 const w=createCallbackWork();assert.equal(w.run(()=>3),3);let release;const p=w.run(()=>new Promise(r=>release=r));assert.equal(w.status().active,1);await assert.rejects(w.drain({timeoutMs:10}),/timed out/);assert.equal(w.status().active,1);release();await p;assert.deepEqual(await w.drain(),{active:0,failures:0})
})
test('swallowed callback rejection still blocks transfer checks',async()=>{
 const w=createCallbackWork();await w.run(async()=>{throw Error('synthetic')}).catch(()=>{});await assert.rejects(w.drain(),/requires review/);assert.equal(w.status().failures,1)
})
test('sync errors remain synchronous and are not erased by later success',async()=>{
 const w=createCallbackWork();assert.throws(()=>w.run(()=>{throw Error('synthetic')}));w.run(()=>true);await assert.rejects(w.drain(),/requires review/)
})
