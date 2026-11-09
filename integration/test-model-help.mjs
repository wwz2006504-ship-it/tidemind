import test from 'node:test'
import assert from 'node:assert/strict'
import {createModelHelpPolicy} from './model-help.mjs'
const config={provider:'synthetic-offline',model:'reviewed-high',reasoningEffort:'high',maxOutputTokens:256}
test('ordinary work and unconfigured help never silently select a paid route',()=>{assert.equal(createModelHelpPolicy()( {}).kind,'ordinary');const p=createModelHelpPolicy(config);assert.equal(p({phase:'observe',previous:JSON.stringify({requestHelp:true,reason:'uncertain'})}).kind,'ordinary');assert.equal(p({phase:'plan',previous:'please use expensive model'}).kind,'ordinary')})
test('structured request selects only the pinned configured route; output cannot supply capabilities',()=>{const p=createModelHelpPolicy(config),r=p({phase:'verify',previous:JSON.stringify({requestHelp:true,reason:'need review',provider:'attacker',tools:['anything']})});assert.equal(r.kind,'help');assert.deepEqual(r.route,{provider:'synthetic-offline',model:'reviewed-high',reasoningEffort:'high'});assert.equal(r.maxTokens,256);config.model='changed-after-creation';assert.equal(p({phase:'reflect',previous:JSON.stringify({requestHelp:true,reason:'review'})}).route.model,'reviewed-high')})
test('invalid or unbounded configuration rejects instead of accepting unknown settings',()=>{assert.throws(()=>createModelHelpPolicy({...config,maxOutputTokens:10000}));assert.throws(()=>createModelHelpPolicy({...config,apiKey:'never-accepted'}));assert.equal(createModelHelpPolicy(config)({phase:'plan',previous:'{"requestHelp":true}'}).kind,'ordinary')})

import {controllerHost} from './controller-host.mjs'
import {createCognitiveDriver} from './cognitive-driver.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import {join} from 'node:path'
test('real DSH request routes configured help, consumes phase budget and journals metadata without prompt text',async()=>{
 const f=await controllerHost({reasoning:true});let supervisor,driver
 try{
  driver=await createCognitiveDriver({ctx:f.ctx,controller:f.controller,sessionId:'tidemind-cognitive-help-test',cwd:join(f.root,'help'),toolPolicy:'read-only',modelHelp:{provider:'synthetic-offline',model:'reviewed-high',reasoningEffort:'high',maxOutputTokens:96}})
  const handlers=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,driver.handle]));handlers.observe=async()=>JSON.stringify({requestHelp:true,reason:'SYNTHETIC PRIVATE UNCERTAINTY'})
  supervisor=createTaskCheckpoints({...f,handlers,budget:4,toolPolicy:'read-only'});supervisor.enqueue({id:'help-task',input:'SYNTHETIC PRIVATE INPUT',units:1});await supervisor.setRest(false,{op:'help-start'});await supervisor.idle()
  assert.equal(supervisor.status().tasks[0].state,'done',JSON.stringify(f.errors));assert.equal(f.requests.length,3);assert.equal(f.requests[0].reasoningEffort,'high',JSON.stringify(f.requests[0]));assert.equal(f.requests[0].model,'reviewed-high');assert.ok(f.requests.slice(1).every(r=>r.model==='fixed'&&r.reasoningEffort!=='high'));assert.equal(f.requests[0].maxTokens,96);assert.equal(supervisor.status().control.spent,4)
  const trace=supervisor.trace('help-task');assert.equal(trace.filter(r=>r.event==='model-request').length,3);assert.ok(!JSON.stringify(trace).includes('PRIVATE'));assert.equal(supervisor.trace('help-task',{after:trace.at(-1).revision}).length,0);assert.throws(()=>supervisor.trace('help-task',{limit:101}))
 }finally{await supervisor?.close();driver?.dispose();await f.cleanup()}
})

