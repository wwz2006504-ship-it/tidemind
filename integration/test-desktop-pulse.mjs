import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {mountDesktopPulse} from './desktop-pulse.mjs'

test('desktop add-on mounts at rest, scopes controls to owner, and keeps legacy settings untouched',
 {skip:process.platform!=='win32'},async()=>{
 const root=mkdtempSync(join(tmpdir(),'tidemind-desktop-pulse-'))
 const legacyLease=process.env.TIDEMIND_LEASE_DB,legacyRoot=process.env.TIDEMIND_SANDBOX_ROOT
 let build,dispose,modelTouches=0
 const api={
  isOwner:id=>String(id)==='42',defineTool:x=>x,config:()=>({ownerQQ:'42'}),
  tool:fn=>{build=fn;return ()=>{build=undefined}},
  on:()=>()=>{},onDispose:fn=>{dispose=fn},
  dsh:{get(){modelTouches++;throw Error('Rest must not load the model')}},
 }
 try{
  await mountDesktopPulse(api,{root,installId:'synthetic-pulse'})
  const receipt=()=>JSON.parse(readFileSync(join(root,'mounted.json')))
  assert.equal(receipt().mounted,true)
  assert.equal(build({chat:{kind:'private',userId:'43'}}),null)
  assert.equal(build({chat:{kind:'group',userId:'42'}}),null)
  const tool=build({chat:{kind:'private',userId:'42'}})
  await tool.execute({action:'enqueue',goal:'Synthetic goal'},{callId:'synthetic-goal'})
  const status=await tool.execute({action:'status'})
  assert.equal(status.rest,true)
  assert.equal(status.spent,0)
  assert.equal(status.tasks[0].state,'queued')
  assert.equal(modelTouches,0)
  assert.equal(process.env.TIDEMIND_LEASE_DB,legacyLease)
  assert.equal(process.env.TIDEMIND_SANDBOX_ROOT,legacyRoot)
  dispose()
  for(let i=0;i<50&&receipt().mounted;i++)await new Promise(r=>setTimeout(r,10))
  assert.equal(receipt().mounted,false)
 }finally{dispose?.();rmSync(root,{recursive:true,force:true})}
})
