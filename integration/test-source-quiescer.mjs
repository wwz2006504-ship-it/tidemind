import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSourceQuiescer} from './source-quiescer.mjs'
function fixture(overrides={}){
 const events=[];let state='open';const s={state,op:null,pending:0,uncertain:0,expired:0}
 const sourceAdmission={pause(op){events.push('pause');s.state='paused';s.op=op},status:()=>({...s}),async drain(){events.push('callbacks')}}
 const steps=Object.fromEntries(['tasks','hub','agents','sessions','memory','outbound','modules'].map(k=>[k,async()=>{events.push(k);assert.equal(state,'open')}]))
 const memoryBarrier={begin(){events.push('freeze');state='blocked'},seal(op,read){events.push('seal');return read()}}
 const q=createSourceQuiescer({sourceAdmission,memoryBarrier,compositeHead:()=>({digest:'synthetic'}),steps,verifyQuiet:()=>({quiet:true}),...overrides})
 return {q,s,events,steps}
}
test('all original drains finish with memory writable before freeze and seal',async()=>{const f=fixture();assert.equal((await f.q.prepare('one')).sealed,true);assert.deepEqual(f.events,['pause','callbacks','tasks','hub','agents','sessions','memory','outbound','modules','freeze','seal'])})
test('dry run has no source or memory effects',async()=>{const f=fixture();assert.equal((await f.q.prepare('preview',{dryRun:true})).dryRun,true);assert.deepEqual(f.events,[])})
test('new deferred input prevents freeze and is never silently discarded',async()=>{const f=fixture();f.steps.hub=async()=>{f.s.pending++};await assert.rejects(f.q.prepare('late'),/deferred input/);assert.equal(f.s.state,'paused');assert.ok(!f.events.includes('freeze'))})
test('unknown final proof or subsystem failure retains source pause',async()=>{for(const overrides of [{verifyQuiet:()=>({quiet:false})},{verifyQuiet:()=>{throw Error('unknown QQ')}}]){const f=fixture(overrides);await assert.rejects(f.q.prepare('unknown'));assert.equal(f.s.state,'paused');assert.ok(!f.events.includes('freeze'))}})
test('hung adapter times out without sealing and receives cancellation',async()=>{const f=fixture();let signal;f.steps.agents=async options=>{signal=options.signal;await new Promise(()=>{})};await assert.rejects(f.q.prepare('hang',{timeoutMs:15}),/timed out/);assert.equal(signal.aborted,true);assert.equal(f.s.state,'paused');assert.ok(!f.events.includes('freeze'));await assert.rejects(f.q.prepare('retry'),/outcome unresolved/)})
test('missing module coverage rejects construction',()=>{assert.throws(()=>createSourceQuiescer({steps:{}}),/all original subsystem/)})

test('task export runs after the final proof and before freeze; bundle is returned with the seal',async()=>{
 const bundle={digest:'d'.repeat(64)};const f=fixture({exportTasks:async()=>{f.events.push('export-tasks');return bundle}})
 const r=await f.q.prepare('with-tasks');assert.equal(r.taskBundle,bundle)
 assert.deepEqual(f.events,['pause','callbacks','tasks','hub','agents','sessions','memory','outbound','modules','export-tasks','freeze','seal'])
 assert.deepEqual((await f.q.prepare('p',{dryRun:true})).order.slice(-3),['export-tasks','freeze','seal'])
})
test('task export failure or unverifiable bundle retains the pause and never freezes',async()=>{
 for(const exportTasks of [async()=>{throw Error('tasks still running')},async()=>({}),async()=>null]){
  const f=fixture({exportTasks});await assert.rejects(f.q.prepare('bad'));assert.equal(f.s.state,'paused');assert.ok(!f.events.includes('freeze')&&!f.events.includes('seal'))}
})
test('drain-only mode never exports tasks, and a non-function hook is rejected at construction',async()=>{
 let called=false;const f=fixture({verifyQuiet:()=>({quiet:true,drained:true}),exportTasks:async()=>{called=true;return {digest:'x'}}});const r=await f.q.drain('d');assert.equal(r.drained,true);assert.equal(called,false)
 assert.throws(()=>fixture({exportTasks:'nope'}),/task export/)
})
