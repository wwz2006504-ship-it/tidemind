import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'

test('same-authority synchronous guard reuses transaction and sees current uncommitted state',async()=>{
 const f=await fixture();try{
  f.lease.fenced('local',f.term,db=>{
   db.prepare('UPDATE tide_head SET revision=10').run()
   assert.equal(f.lease.fenced('local',f.term,inner=>{assert.equal(inner,db);return inner.prepare('SELECT revision FROM tide_head').get().revision}),10)
  })
  assert.equal(f.gateway.head(f.lease).revision,10)
 }finally{f.cleanup()}
})
test('borrowed transaction cannot impersonate another holder or term and cannot run async callback',async()=>{
 const f=await fixture();try{
  f.lease.fenced('local',f.term,()=>{
   assert.throws(()=>f.lease.fenced('cloud',f.term,()=>{}),/FENCED/)
   assert.throws(()=>f.lease.fenced('local',f.term+1,()=>{}),/FENCED/)
   assert.throws(()=>f.lease.fenced('local',f.term,async()=>{}),/asynchronous/)
  })
 }finally{f.cleanup()}
})
test('nested guard failure rolls back the whole authority operation',async()=>{
 const f=await fixture();try{
  assert.throws(()=>f.lease.fenced('local',f.term,db=>{db.prepare('UPDATE tide_head SET revision=10').run();f.lease.fenced('local',f.term,()=>{throw Error('synthetic abort')})}),/synthetic abort/)
  assert.equal(f.gateway.head(f.lease).revision,0)
 }finally{f.cleanup()}
})
