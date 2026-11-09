import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSessionEventQueue} from './session-event-queue.mjs'
import {aurabotHost} from './aurabot-host-fixture.mjs'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
test('per-session async binding completes before reply; other sessions can advance',async()=>{
 let release;const gate=new Promise(r=>release=r),seen=[],q=createSessionEventQueue({handler:async(s,e)=>{if(s.id==='a'&&e==='bind')await gate;seen.push(s.id+':'+e)}})
 const first=q.run({id:'a'},'bind'),second=q.run({id:'a'},'reply');await q.run({id:'b'},'independent');assert.deepEqual(seen,['b:independent']);assert.equal(q.status().active,2)
 release();await Promise.all([first,second]);assert.deepEqual(seen,['b:independent','a:bind','a:reply']);assert.equal((await q.close()).active,0)
 await assert.rejects(q.run({id:'a'},'late'),/closed/)
})
test('failed binding stops later session effects and retains failed drain evidence',async()=>{
 const seen=[],q=createSessionEventQueue({handler:async(_s,e)=>{if(e==='bind')throw Error('SYNTHETIC BIND LOST');seen.push(e)}})
 const a=q.run({id:'a'},'bind'),b=q.run({id:'a'},'reply');await Promise.allSettled([a,b]);assert.deepEqual(seen,[]);assert.equal(q.status().failures,1);await assert.rejects(q.drain(),/requires review/)
})
test('candidate host awaits async original turn binding before sending actual native reply',async()=>{
 let h,release,entered=false
 try{const gate=new Promise(r=>release=r);h=await aurabotHost({prepareBindings:()=>({createCapabilities:options=>{const cap=createOneBotCapabilities(options),original=cap.outbound.bindTurn;return {...cap,outbound:{...cap.outbound,bindTurn:async request=>{if(!entered){entered=true;await gate}return original(request)}}}}})})
 await h.emit(h.event(51001));for(let i=0;i<200&&!entered;i++)await new Promise(r=>setTimeout(r,5));assert.equal(entered,true);assert.equal(h.sent.length,0);assert.ok(h.handle.transferLifecycle.status().sessionEvents.active>0)
 release();await h.settle();assert.equal(h.sent.length,1);assert.equal(h.handle.transferLifecycle.status().sessionEvents.failures,0)
 }finally{release?.();if(h)await h.cleanup()}
})
