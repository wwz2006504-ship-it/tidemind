import test from 'node:test'
import assert from 'node:assert/strict'
import {controllerQQ} from './controller-qq-fixture.mjs'
test('original Hub -> real Controller/Loop -> retrieval/capture -> fenced QQ -> durable confirmation',async()=>{
 const f=await controllerQQ();try{
  const before=f.replica.replicaHead(f.local).protected_hash
  await f.hub.onMessage(f.event());await f.settle()
  assert.deepEqual(f.errors,[]);assert.equal(f.sent.length,1)
  assert.ok(JSON.stringify(f.requests[0].messages).includes('合成检索标记'))
  assert.ok(f.read("SELECT * FROM memories WHERE content LIKE '%蓝色风铃%'").length>0)
  assert.equal(f.replica.replicaHead(f.local).protected_hash,before)
  assert.equal(f.read("SELECT count(*) n FROM memories WHERE layer='semantic'")[0].n,2)
  assert.ok(f.hub.lastChatAt>0);assert.equal(f.hub.stats().sent,1)
  assert.ok(!f.logs.some(l=>l.level==='warn'))
  const review=await f.outbound.reviewAdmissions();assert.equal(review[0].state,'accepted')
  const head=f.gateway.head(f.lease);assert.ok(head.revision>=1)
  const snapshot=f.agent.session.snapshotEvents();assert.ok(snapshot.some(e=>e.type==='user/message'));assert.ok(snapshot.some(e=>e.type==='assistant/message'));assert.ok(snapshot.some(e=>e.type==='turn/end'))
  await f.hub.onMessage(f.event());await new Promise(r=>setTimeout(r,15));assert.equal(f.sent.length,1);assert.equal(f.gateway.head(f.lease).revision,head.revision)
 }finally{await f.cleanup()}
})

test('real loop executes original search/write tools and commits before the QQ reply',async()=>{
 const f=await controllerQQ({mode:'memory-tools'});try{
  await f.hub.onMessage(f.event(1002,'麦克风'));await f.settle()
  assert.deepEqual(f.errors,[]);assert.equal(f.requests.length,3);assert.equal(f.sent.length,1)
  assert.ok(f.read("SELECT id FROM memories WHERE content='合成工具链已提交 风铃约定'").length===1)
  const events=f.agent.session.snapshotEvents();assert.equal(events.filter(e=>e.type==='tool/result').length,2)
  const writeResult=events.filter(e=>e.type==='tool/result').at(-1);assert.ok(!JSON.stringify(writeResult).includes('FENCED'))
  assert.ok(f.gateway.head(f.lease).revision>=1)
 }finally{await f.cleanup()}
})
test('real loop core write is rejected; original identity is preserved',async()=>{
 const f=await controllerQQ({mode:'core-attempt'});try{
  const before=f.replica.replicaHead(f.local).protected_hash
  await f.hub.onMessage(f.event(1003,'麦克风'));await f.settle()
  assert.deepEqual(f.errors,[]);assert.equal(f.read("SELECT id FROM memories WHERE content='不允许覆盖身份'").length,0)
  assert.equal(f.replica.replicaHead(f.local).protected_hash,before)
  const result=f.agent.session.snapshotEvents().find(e=>e.type==='tool/result');assert.ok(result);assert.equal(result.data.message.isError,true)
 }finally{await f.cleanup()}
})

test('unmarked aurabot background input does not trigger memory retrieval or capture',async()=>{
 const f=await controllerQQ();try{
  const prior=f.gateway.head(f.lease).revision
  f.agent.followup({id:'synthetic-background',role:'user',content:[{type:'text',text:'麦克风 我喜欢不应捕获的合成消息'}],source:{kind:'aurabot'}})
  await f.settle();assert.deepEqual(f.errors,[])
  assert.ok(!JSON.stringify(f.requests[0].messages).includes('合成检索标记'))
  assert.equal(f.gateway.head(f.lease).revision,prior);assert.equal(f.sent.length,0)
 }finally{await f.cleanup()}
})
test('another real controller session cannot read xiyu injected memories or auto-capture',async()=>{
 const f=await controllerQQ();try{
  const prior=f.gateway.head(f.lease).revision
  const created=await f.controller.create({sessionId:'session-unbound-other',cwd:f.root})
  const {agent}=await f.controller.resolveAgent(created.sessionId)
  agent.followup({id:'unbound-input',role:'user',content:[{type:'text',text:'麦克风 我喜欢不应串入的合成消息'}],source:{kind:'user'}})
  for(let i=0;i<300&&!agent.session.snapshotEvents().some(e=>e.type==='turn/end');i++)await new Promise(r=>setTimeout(r,5))
  assert.ok(agent.session.snapshotEvents().some(e=>e.type==='turn/end'));assert.deepEqual(f.errors,[])
  assert.ok(!JSON.stringify(f.requests[0].messages).includes('合成检索标记'));assert.equal(f.gateway.head(f.lease).revision,prior)
 }finally{await f.cleanup()}
})

test('fresh real Controller cold-resumes persisted conversation after full runtime shutdown; new event replies once',async()=>{
 let f=await controllerQQ();try{
  const identity=f.replica.replicaHead(f.local).protected_hash
  await f.hub.onMessage(f.event(1101,'麦克风'));await f.settle();assert.equal(f.sent.length,1)
  const before=f.agent.session.snapshotEvents().length,storageFixture=f.storageFixture,id=f.agent.id
  await f.shutdown()
  f=await controllerQQ({storageFixture,resumeSessionId:id})
  assert.equal(f.agent.id,id);assert.ok(f.agent.session.snapshotEvents().length>=before)
  await f.hub.onMessage(f.event(1101,'麦克风'));assert.equal(f.sent.length,0)
  await f.hub.onMessage(f.event(1102,'麦克风'));await f.settle();assert.deepEqual(f.errors,[]);assert.equal(f.sent.length,1)
  await f.hub.onMessage(f.event(1102,'麦克风'));await new Promise(r=>setTimeout(r,15));assert.equal(f.sent.length,1)
  assert.equal(f.replica.replicaHead(f.local).protected_hash,identity)
  assert.ok((await f.outbound.reviewAdmissions()).every(r=>r.state==='accepted'))
 }finally{await f.cleanup()}
})
