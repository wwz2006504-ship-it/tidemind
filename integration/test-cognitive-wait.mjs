import test from 'node:test'
import assert from 'node:assert/strict'
import {waitForFree} from './cognitive-driver.mjs'
test('waits for a busy session to free up instead of failing the first step',async()=>{
 let busy=true;setTimeout(()=>{busy=false},60)
 await waitForFree({busy:()=>busy,timeoutMs:2000,pollMs:10})
})
test('gives up with a retryable TIDEMIND_BUSY error after the bounded wait',async()=>{
 await assert.rejects(waitForFree({busy:()=>true,timeoutMs:60,pollMs:10}),e=>e.code==='TIDEMIND_BUSY'&&e.retryable===true&&/busy/.test(e.message))
})
test('an aborted task stops waiting at once',async()=>{
 const c=new AbortController();setTimeout(()=>c.abort(),30)
 const t=Date.now();await assert.rejects(waitForFree({busy:()=>true,timeoutMs:5000,pollMs:10,signal:c.signal}))
 assert.ok(Date.now()-t<1000)
})
