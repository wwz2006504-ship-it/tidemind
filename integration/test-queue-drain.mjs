import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createQueueDrain} from './queue-drain.mjs'
test('merge drain waits for prompt construction removed from pending and for turn release',async()=>{
 const pending=new Map([['chat',true]]);let busy=false,release
 const q=createQueueDrain({pending,isBusy:()=>busy,disposed:()=>false,flush:()=>q.track(async()=>{pending.clear();await new Promise(r=>release=r);busy=true})})
 let done=false;const draining=q.drain().then(()=>done=true)
 while(!release)await new Promise(r=>setTimeout(r,1))
 assert.equal(pending.size,0);assert.equal(q.status().active,1);assert.equal(done,false)
 release();await new Promise(r=>setTimeout(r,10));assert.equal(done,false);busy=false;await draining
})
test('unknown dispatch failure stays blocking on repeated drain',async()=>{
 const q=createQueueDrain({pending:new Map(),isBusy:()=>false,disposed:()=>false,flush:()=>{}})
 await assert.rejects(q.track(()=>{throw Error('synthetic')}));await assert.rejects(q.drain(),/uncertain/);await assert.rejects(q.drain(),/uncertain/)
})
test('busy queue timeout and cancellation never report drained',async()=>{
 const q=createQueueDrain({pending:new Map(),isBusy:()=>true,disposed:()=>false,flush:()=>{}})
 await assert.rejects(q.drain({timeoutMs:10}),/timed out/)
 const controller=new AbortController();controller.abort();await assert.rejects(q.drain({signal:controller.signal}),/abort/i)
})
