import test from 'node:test'
import assert from 'node:assert/strict'
import {createModuleActivity} from './module-activity.mjs'
import {createManagedHeartbeat} from './managed-heartbeat.mjs'
const makeAgent=id=>{const counts={on:0,off:0};return {id,session:{id},status:'idle',ctx:{on(){counts.on++;let off=false;return ()=>{if(!off){off=true;counts.off++}}}},counts}}
function fixture(){let current=makeAgent('first'),old=current;const observed=[]
 const supervisor={async runActivity(task,fn){return {state:'done',value:await fn({id:task.id,guard(){},signal:new AbortController().signal})}},async setRest(){return {drained:true}}}
 const capabilities={wrapAutonomousTool(tool){return {execute(args,options){observed.push(options.agent);return tool.execute(args,options)}}}}
 const activity=createModuleActivity({supervisor,capabilities,agent:current,ctx:{},resolveActivityAgent:async()=>current,assertActivityAgent:agent=>{if(agent!==current)throw Error('owner mapping changed')}})
 return {old,activity,observed,get current(){return current},set current(a){current=a}}
}
test('module selects current owner before callback and detaches old request listener',async()=>{const f=fixture();try{const run=f.activity.wrap(()=>true,{moduleId:'rollover',label:'test',guard(){}});await run();f.current=makeAgent('next');await run();assert.deepEqual(f.observed.map(a=>a.id),['first','next']);assert.equal(f.old.counts.off,1);assert.equal(f.current.counts.on,1)}finally{await f.activity.close()}assert.equal(f.current.counts.off,1)})
test('mapping changing during callback rejects delayed protected execution',async()=>{const f=fixture();try{const run=f.activity.wrap(()=>{f.current=makeAgent('next');return f.activity.protectCore({hub:{pushToSession(){assert.fail('stale wake')}}}).hub.pushToSession({kind:'private'})},{moduleId:'stale',label:'test',guard(){}});await assert.rejects(run(),/owner mapping changed/)}finally{await f.activity.close()}})
test('heartbeat follows current owner while retaining unattended counters and disposing old listener',async()=>{const f=fixture();const heartbeat=createManagedHeartbeat({activity:f.activity,agent:f.old,hub:{pushToSession(){}},chat:{kind:'private'},readConfig:()=>({enabled:false,intervalSeconds:30}),legacyDetached:true});try{heartbeat.start();heartbeat.runtime.missedCount=2;heartbeat.runtime.paused=true;f.current=makeAgent('next');await heartbeat.tick();assert.equal(heartbeat.runtime.agent,f.current);assert.equal(heartbeat.runtime.missedCount,2);assert.equal(heartbeat.runtime.paused,true);assert.equal(f.old.counts.off,2);assert.equal(f.current.counts.on,2)}finally{heartbeat.dispose();await f.activity.close()}assert.equal(f.current.counts.off,2)})
