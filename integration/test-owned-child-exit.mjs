import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {stopOwnedChild} from './owned-child-exit.mjs'

test('exact real spawned child exit is awaited and repeated stops share result; unrelated child survives',async()=>{
 const children=[spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}),spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'})]
 try{
  await Promise.all(children.map(child=>once(child,'spawn')))
  const result=stopOwnedChild(children[0]),again=stopOwnedChild(children[0]);assert.equal(result,again)
  assert.equal((await result).exited,true);assert.ok(children[0].exitCode!==null||children[0].signalCode!==null)
  assert.equal(children[1].exitCode,null);assert.equal(children[1].signalCode,null)
  assert.equal((await stopOwnedChild(null)).absent,true)
  assert.throws(()=>stopOwnedChild({kill(){}}),/actual owned/)
 }finally{await Promise.allSettled(children.map(child=>stopOwnedChild(child)))}
})

test('unconfirmed child termination times out and retains failure instead of declaring exit',async()=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});await once(child,'spawn')
 const kill=child.kill.bind(child)
 try{
  child.kill=()=>true
  const stopping=stopOwnedChild(child,{timeoutMs:10});await assert.rejects(stopping,/exit unconfirmed/)
  assert.equal(child.exitCode,null);assert.equal(child.signalCode,null)
  assert.equal(stopOwnedChild(child),stopping)
 }finally{const exited=once(child,'exit');kill();await exited}
})
