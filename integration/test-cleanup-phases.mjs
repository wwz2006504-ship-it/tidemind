import {test} from 'node:test'
import assert from 'node:assert/strict'
import {cleanupPhases} from './cleanup-phases.mjs'
test('synchronous stop error cannot skip other stops or later drains',async()=>{
 const called=[];await assert.rejects(cleanupPhases([[()=>{called.push('bad');throw Error('synthetic')},()=>called.push('stop')],[()=>called.push('drain')]]),AggregateError);assert.deepEqual(called,['bad','stop','drain'])
})
test('failed panel drain still waits asynchronous module drain before reporting',async()=>{
 let release,done=false;const work=cleanupPhases([[()=>{throw Error('panel')},()=>new Promise(r=>release=r)]]).catch(e=>{done=true;return e})
 await new Promise(r=>setTimeout(r,5));assert.equal(done,false);release();const error=await work;assert.equal(error.errors.length,1)
})
test('multiple failures are retained while later phases execute',async()=>{
 let last=false;try{await cleanupPhases([[()=>Promise.reject(Error('one')),()=>{throw Error('two')}],[()=>{last=true}]]);assert.fail()}catch(e){assert.equal(e.errors.length,2);assert.equal(last,true)}
})
