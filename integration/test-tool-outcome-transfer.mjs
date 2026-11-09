import {test} from 'node:test'
import assert from 'node:assert/strict'
import {authorityHttpFixture} from './authority-http-fixture.mjs'

for(const state of ['executing','attempted','unknown'])test(`canonical handover and failover both stop on ${state} external tool outcome`,async()=>{
 const f=await authorityHttpFixture({qqConfig:{selfId:10001,allowTargets:['private:20001'],transport:async()=>({})}})
 try{
  await f.local.request('/qq/status',{term:f.term})
  f.lease.fenced('local',f.term,db=>db.prepare('INSERT INTO tide_tool_permits VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('outcome-op','hash','approval','session','call','get_cookies','params','local',f.term,Date.now()+30000,state,'attempt','result'))
  assert.throws(()=>f.gateway.handover(f.lease,'local',f.term,{op:'transfer',target:'cloud',expectedRevision:f.ack.revision,expectedHash:f.ack.hash,sourceAck:f.ack,targetAck:f.ack}),/unresolved tool outcomes/)
  assert.equal(f.gateway.head(f.lease).home,'local')
  f.lease.release('local',f.term);const next=f.lease.acquire('cloud',{ttl:60000}).term
  assert.throws(()=>f.gateway.takeover(f.lease,'cloud',next,{expectedRevision:f.ack.revision,expectedHash:f.ack.hash,targetAck:f.ack,expectedComposite:f.ack.composite}),/unresolved tool outcomes/)
  assert.equal(f.gateway.head(f.lease).home,'local')
 }finally{await f.cleanup()}
})
