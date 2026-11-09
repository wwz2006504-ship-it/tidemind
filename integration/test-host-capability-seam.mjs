import {test} from 'node:test'
import assert from 'node:assert/strict'
import {resolveHostCapabilities} from './host-capabilities.mjs'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
import {aurabotHost} from './aurabot-host-fixture.mjs'
import {createHostTaskControl} from './host-task-control.mjs'
import taskModule from './tidemind-control.mjs'
test('same candidate host uses explicitly injected complete original capabilities and still replies once',async()=>{
 let factories=0,h
 try{h=await aurabotHost({prepareBindings:()=>({createCapabilities:options=>{factories++;return createOneBotCapabilities(options)}})})
 await h.emit(h.event(48001));await h.settle();assert.equal(factories,1);assert.equal(h.sent.length,1)
 await h.emit(h.event(48001));assert.equal(h.sent.length,1);assert.deepEqual(h.errors,[])
 }finally{if(h)await h.cleanup()}
})
test('owner task tool awaits remote status/enqueue and waits for real rest receipt',async()=>{
 const pending=new Set();let release,stopped=false
 const control=createHostTaskControl({pending,assertHostActive:()=>{if(stopped)throw Error('stopped')},remote:{status:async()=>({control:{rest:0},active:1}),enqueue:async task=>({id:task.id,replayed:false}),setRest:()=>new Promise(r=>release=r)}})
 let builder;taskModule.setup({tool:fn=>builder=fn,rule:()=>{},isOwner:()=>true,defineTool:value=>value,core:{tidemind:control}})
 const [tool]=builder({chat:{kind:'private',userId:'owner'},level:'full'}),exec={agent:{session:{id:'synthetic-owner'}},callId:'synthetic-call'}
 const status=await tool.execute({action:'status'},exec);assert.equal(status.rest,false);assert.equal(status.drained,false)
 assert.ok((await tool.execute({action:'enqueue',input:'SYNTHETIC'},exec)).id.startsWith('owner:'))
 let complete=false;const rest=tool.execute({action:'rest'},exec).then(value=>{complete=true;return value})
 assert.equal(pending.size,1);assert.equal(complete,false);release({rest:true,drained:true});assert.equal((await rest).drained,true);assert.equal(pending.size,0)
 stopped=true;assert.throws(()=>control.status(),/stopped/)
})
test('remote task status or rest without valid confirmation cannot claim success',async()=>{
 const control=createHostTaskControl({pending:new Set(),assertHostActive:()=>{},remote:{status:async()=>({control:{rest:1}}),enqueue:async()=>({}),setRest:async()=>({rest:true})}})
 await assert.rejects(control.status(),/unconfirmed/);await assert.rejects(control.requestRest(true,{op:'bad'}),/unconfirmed/)
})
test('partial or asynchronous capability construction refuses startup without local fallback',()=>{
 assert.throws(()=>resolveHostCapabilities(()=>({moduleClient:{call(){}}}),{}),/complete original/)
 assert.throws(()=>resolveHostCapabilities(()=>Promise.resolve({}),{}),/complete original/)
 assert.throws(()=>resolveHostCapabilities('remote',{}),/factory required/)
})
test('panel tracks pending async source verification and does not admit paused requests',async()=>{
 let resolve,state={state:'open'},pending=false,h,sourcePromise
 try{h=await aurabotHost({builtins:[],prepareBindings:()=>({sourceAdmission:{status:()=>pending?(sourcePromise??=new Promise(r=>resolve=r)):Promise.resolve(state)}})})
 pending=true;const request=h.request('/state')
 for(let i=0;i<100&&!resolve;i++)await new Promise(r=>setTimeout(r,5));assert.equal(typeof resolve,'function')
 assert.equal(h.handle.transferLifecycle.status().panel.active,1)
 pending=false;state={state:'paused'};resolve(state)
 const response=await request;assert.equal(response.ok,false);assert.match(response.message,/source paused/)
 assert.equal(h.handle.transferLifecycle.status().panel.active,0);assert.equal(h.handle.transferLifecycle.status().panel.failures,0)
 state={state:'open'};assert.notEqual((await h.request('/state')).ok,false)
 assert.notEqual((await h.handle.modules.sync())?.skipped,'source-paused');assert.equal(h.handle.transferLifecycle.status().watchdogPaused,false)
 }finally{if(resolve)resolve({state:'paused'});if(h)await h.cleanup()}
})
