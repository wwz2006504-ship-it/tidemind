import test from 'node:test'
import assert from 'node:assert/strict'
import {qqFixture} from './qq-fixture.mjs'
import {createQQOutbound} from './qq-outbound.mjs'

test('actual original Hub ingress->turn->split reply uses one frozen outbox manifest',async()=>{
 const f=await qqFixture();try{
  const e=f.event();await f.hub.onMessage(e);await f.waitAdmissions(1)
  await f.finish('合成第一条|||合成第二条')
  assert.equal(f.sent.length,2);assert.ok(f.sent.every(p=>p.action==='send_private_msg'));assert.equal(f.hub.stats().sent,2);assert.ok(f.hub.lastChatAt>0)
  const audit=f.outbound.audit();assert.equal(audit.outbox.length,1);assert.equal(audit.outbox[0].state,'sent');assert.equal(audit.parts.length,2)
  await f.hub.onMessage(e);await new Promise(r=>setTimeout(r,10));assert.equal(f.admissions.length,1);assert.equal(f.sent.length,2)
 }finally{await f.cleanup()}
})
test('same event/concurrent reply retries never repeat a segment',async()=>{
 const f=await qqFixture();try{
  const binding=f.bind([f.event()]);await Promise.all([f.reply(binding,'合成回复'),f.reply(binding,'合成回复')]);await f.reply(binding,'合成回复')
  assert.equal(f.sent.length,1)
  await assert.rejects(f.reply(binding,'换了内容'),/conflict/);assert.equal(f.sent.length,1)
 }finally{await f.cleanup()}
})
test('partial send ACK loss records sent+unknown; no whole-turn resend',async()=>{
 let attempts=0
 const f=await qqFixture({transport:async()=>{attempts++;if(attempts===2)throw new Error('simulated ACK loss');return {message_id:80001}}})
 try{
  const binding=f.bind([f.event()]);assert.equal((await f.reply(binding,'合成第一条|||合成第二条')).state,'unknown')
  await f.reply(binding,'合成第一条|||合成第二条');assert.equal(attempts,2)
  assert.deepEqual(f.outbound.audit().parts.map(p=>p.state),['sent','unknown'])
 }finally{await f.cleanup()}
})
test('outbound reinitialization retains inbox, turn binding, frozen reply and receipts',async()=>{
 const f=await qqFixture();try{
  const e=f.event(),binding=f.bind([e]);await f.reply(binding,'合成重启回复')
  const restarted=createQQOutbound({...f,holder:'local',selfId:'10001',allowTargets:['private:20001'],transport:async()=>assert.fail('duplicate transport')})
  assert.equal(restarted.observeInbound(e,{chatId:'private:20001',userId:'20001',messageId:'101'}).admitted,false)
  const outcome=await restarted.reply(binding,f.render(binding.chatId,'合成重启回复'));assert.equal(outcome.state,'sent');assert.equal(f.sent.length,1)
 }finally{await f.cleanup()}
})
test('old term and unavailable authority stop before transport, no fallback',async()=>{
 const f=await qqFixture();try{
  const binding=f.bind([f.event()]);f.lease.release('local',f.term);f.lease.acquire('local')
  await assert.rejects(f.reply(binding,'禁止旧任期发送'),/FENCED/);assert.equal(f.sent.length,0)
  const fenced=f.lease.fenced;f.lease.fenced=()=>{throw new Error('authority unavailable')}
  await assert.rejects(f.reply(binding,'禁止断线发送'),/unavailable/);assert.equal(f.sent.length,0);f.lease.fenced=fenced
 }finally{await f.cleanup()}
})
test('hook.send failure cannot bypass final boundary; unbound direct send denied',async()=>{
 const f=await qqFixture({hooks:{send:()=>{throw new Error('hook failed')}}});try{
  await assert.rejects(f.hub.sendText('private:20001','禁止旁路'),/unbound/);assert.equal(f.sent.length,0)
  await assert.rejects(f.outbound.guardedClient.call('send_private_msg',{}),/denied/)
  await f.reply(f.bind([f.event()]),'合成受控回复');assert.equal(f.sent.length,1)
 }finally{await f.cleanup()}
})
test('stable IDs required, wrong bot/target rejected; changed body same ID conflicts',async()=>{
 const f=await qqFixture();try{
  assert.throws(()=>f.observe(f.event('0')),/identifier/)
  assert.throws(()=>f.observe({...f.event(),self_id:99999}),/untrusted/)
  assert.throws(()=>f.observe(f.event('1','99999')),/target/)
  f.observe(f.event());assert.throws(()=>f.observe(f.event('101','20001','内容被替换')),/conflict/)
  assert.equal(f.sent.length,0)
 }finally{await f.cleanup()}
})
test('overlapping merged turns cannot answer same inbound event twice',async()=>{
 const f=await qqFixture();try{
  const a=f.event('1'),b=f.event('2'),both=f.bind([a,b],1)
  await f.reply(both,'合成合并回复')
  const single=f.bind([a],2)
  await assert.rejects(f.reply(single,'错误的重复回复'),/overlapping/);assert.equal(f.sent.length,1)
 }finally{await f.cleanup()}
})
test('silence is frozen too; retry cannot silently change it into a new send',async()=>{
 const f=await qqFixture();try{
  const binding=f.bind([f.event()]);await f.reply(binding,'[沉默]');assert.equal(f.sent.length,0)
  await assert.rejects(f.reply(binding,'后来变成回复'),/conflict/);assert.equal(f.sent.length,0)
 }finally{await f.cleanup()}
})
test('unsupported reply kinds and missing message ACK stay fail-closed',async()=>{
 const f=await qqFixture({transport:async()=>({})});try{
  const binding=f.bind([f.event()]);assert.throws(()=>f.outbound.validateItems([{kind:'unreviewed'}]),/unsupported/)
  assert.equal(f.outbound.audit().outbox.length,0)
  assert.equal((await f.reply(binding,'合成无回执')).state,'unknown')
  assert.equal(f.outbound.audit().parts[0].state,'unknown')
 }finally{await f.cleanup()}
})

test('actual Hub merges two inbound messages into one durable reply without overlap',async()=>{
 const f=await qqFixture({merge:true});try{
  await f.hub.onMessage(f.event('401'));await f.hub.onMessage(f.event('402'))
  await f.waitAdmissions(1);await f.finish('合成合并后的唯一回复')
  assert.equal(f.admissions.length,1);assert.equal(f.sent.length,1);assert.equal(f.outbound.audit().inbox,2)
  await f.hub.onMessage(f.event('401'));await new Promise(r=>setTimeout(r,15));assert.equal(f.admissions.length,1)
 }finally{await f.cleanup()}
})
test('private/group targets and equal message IDs are separately namespaced',async()=>{
 const f=await qqFixture();try{
  await f.reply(f.bind([f.event('501')],1),'合成私聊回复')
  const e={...f.event('501'),message_type:'group',group_id:30001}
  await f.reply(f.bind([e],2,'group:30001'),'合成群聊回复')
  assert.deepEqual(f.sent.map(p=>p.action),['send_private_msg','send_group_msg'])
  assert.equal(f.sent[1].params.group_id,30001);assert.equal(f.outbound.audit().outbox.length,2)
 }finally{await f.cleanup()}
})
test('term change after first ACK prevents next segment and whole-turn retry',async()=>{
 let f,attempts=0
 f=await qqFixture({transport:async()=>{attempts++;f.lease.release('local',f.term);f.lease.acquire('cloud');return {message_id:91001}}})
 try{
  const binding=f.bind([f.event('601')]);assert.equal((await f.reply(binding,'合成第一段|||合成第二段')).state,'unknown')
  assert.equal(attempts,1);assert.deepEqual(f.outbound.audit().parts.map(p=>p.state),['sent','pending'])
  await assert.rejects(f.reply(binding,'合成第一段|||合成第二段'),/FENCED/);assert.equal(attempts,1)
 }finally{await f.cleanup()}
})
test('unknown QQ outcome blocks planned handover; raw enqueue bypass is denied',async()=>{
 const f=await qqFixture({transport:async()=>{throw new Error('ACK lost')}});try{
  await f.reply(f.bind([f.event('701')]),'合成结果不明')
  const h=f.gateway.head(f.lease)
  assert.throws(()=>f.gateway.handover(f.lease,'local',f.term,{op:'unsafe-switch',target:'cloud',expectedRevision:h.revision,expectedHash:h.hash,sourceAck:f.replica.replicaHead(f.local),targetAck:f.replica.replicaHead(f.cloud)}),/unresolved outgoing/)
  assert.throws(()=>f.gateway.enqueue(f.lease,'local',f.term,{channel:'qq',eventId:'fake',payload:'bypass'}),/binding required/)
 }finally{await f.cleanup()}
})
