import test from 'node:test'
import assert from 'node:assert/strict'
import {controllerHost} from './controller-host.mjs'
import {createQQOutbound} from './qq-outbound.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
import {stopForAdmissionRecovery} from './admission-recovery.mjs'
const sender=f=>createQQOutbound({...f,selfId:'10001',allowTargets:['private:20001'],transport:async()=>assert.fail('no QQ'),historyReader:createSessionHistoryReader(f.ctx.sessionPersistence)})
async function missing({prior=false}={}){
 const f=await controllerHost(),out=sender(f)
 if(prior){f.agent.followup({id:'prior-synthetic-turn',role:'user',content:[{type:'text',text:'合成旧会话'}],source:{kind:'user'}});for(let i=0;i<200&&!f.agent.session.snapshotEvents().some(e=>e.type==='turn/end');i++)await new Promise(r=>setTimeout(r,5))}
 await f.ctx.sessions.flush(f.agent.session)
 const event={post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:1601,message:[{type:'text',data:{text:'麦克风'}}]}
 const {origin}=out.observeInbound(event,{chatId:'private:20001',userId:'20001',messageId:'1601'})
 await assert.rejects(out.admitInput({sessionId:f.agent.id,chatId:'private:20001',origins:[origin],content:[{type:'text',text:'麦克风'}],followup:()=>{throw Error('interrupted before native followup')},flush:()=>f.ctx.sessions.flush(f.agent.session)}),/interrupted/)
 return {f,out,id:out.recoveryStatus().admissions[0].id}
}
async function restart(f){
 const proof=await stopForAdmissionRecovery({ctx:f.ctx,agent:f.agent,closeRuntime:f.closeRuntime})
 f.lease.release('local',f.term);const term=f.lease.acquire('local').term
 const fresh=await controllerHost({storageFixture:{...f.storageFixture,term},resumeSessionId:f.agent.id})
 return {fresh,proof,out:sender(fresh)}
}
test('confirmed absent input replays original ID once after clean stop, fresh native writer and new term; dry-run has no effect',async()=>{
 let {f,id}=await missing()
 try{
  const r=await restart(f);f=r.fresh
  const args={id,ctx:f.ctx,agent:f.agent,proof:r.proof}
  assert.equal((await r.out.recoverAdmission(args)).state,'ready');assert.equal(f.requests.length,0)
  const db=f.lease.openAuthority();try{assert.equal(db.prepare('SELECT count(*) n FROM tide_input_recovery').get().n,0)}finally{db.close()}
  const result=await r.out.recoverAdmission({...args,dryRun:false});assert.equal(result.submitted,true)
  for(let i=0;i<200&&!f.agent.session.snapshotEvents().some(e=>e.type==='turn/end');i++)await new Promise(r=>setTimeout(r,5))
  await f.ctx.sessions.flush(f.agent.session)
  assert.deepEqual(f.errors,[]);assert.equal(f.requests.length,1)
  const again=await r.out.recoverAdmission({...args,dryRun:false});assert.equal(again.submitted,false)
  assert.equal(f.agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===id).length,1)
 }finally{await f.cleanup()}
})
test('live old owner / fabricated boundary / unchanged term cannot authorize replay',async()=>{
 let {f,out,id}=await missing()
 try{
  await assert.rejects(out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:{},dryRun:false}),/newer term/)
  const r=await restart(f);f=r.fresh
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:{},dryRun:false}),/clean-stop proof/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
test('expired original content stops before replay',async()=>{
 let {f,id}=await missing()
 try{
  const r=await restart(f);f=r.fresh
  const db=f.lease.openAuthority();try{db.prepare('UPDATE tide_input_payloads SET expires_at=0 WHERE id=?').run(id)}finally{db.close()}
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}),/expired/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
test('stored content conflict stops before replay',async()=>{
 let {f,id}=await missing()
 try{
  const r=await restart(f);f=r.fresh
  const db=f.lease.openAuthority();try{db.prepare('UPDATE tide_input_payloads SET content_json=? WHERE id=?').run('[]',id)}finally{db.close()}
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}),/content conflict/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
test('existing turn binding contradicts absence and blocks replay',async()=>{
 let {f,out,id}=await missing()
 try{
  const db=f.lease.openAuthority();let origin;try{origin=db.prepare('SELECT origin FROM tide_input_journal').get().origin}finally{db.close()}
  out.bindTurn({sessionId:f.agent.id,turn:1,chatId:'private:20001',origins:[origin]})
  const r=await restart(f);f=r.fresh
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}),/bound to turn/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
test('concurrent recovery attempts never submit the same input twice',async()=>{
 let {f,id}=await missing()
 try{
  const r=await restart(f);f=r.fresh
  const a={id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}
  const results=await Promise.allSettled([r.out.recoverAdmission(a),r.out.recoverAdmission(a)])
  assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.submitted).length,1)
  for(let i=0;i<200&&!f.agent.session.snapshotEvents().some(e=>e.type==='turn/end');i++)await new Promise(r=>setTimeout(r,5))
  assert.equal(f.agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===id).length,1)
 }finally{await f.cleanup()}
})
test('a persisted recovery claim with uncertain outcome forbids another submission',async()=>{
 let {f,id}=await missing()
 try{
  const r=await restart(f);f=r.fresh
  const db=f.lease.openAuthority();try{db.prepare("INSERT INTO tide_input_recovery VALUES(?,?,'claimed')").run(id,f.term)}finally{db.close()}
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}),/already attempted/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
import {controllerQQ} from './controller-qq-fixture.mjs'
test('original Hub resumes the same missing input through memory and one QQ reply, without re-rendering input',async()=>{
 let f=await controllerQQ()
 try{
  await f.ctx.sessions.flush(f.agent.session)
  const e=f.event(1701,'麦克风 我喜欢合成恢复风铃'),origin=f.outbound.observeInbound(e,{chatId:'private:20001',userId:'20001',messageId:'1701'}).origin
  await assert.rejects(f.outbound.admitInput({sessionId:f.agent.id,chatId:'private:20001',origins:[origin],content:[{type:'text',text:'麦克风 我喜欢合成恢复风铃'}],followup:()=>{throw Error('test interruption')},flush:()=>f.ctx.sessions.flush(f.agent.session)}),/interrupted/)
  const id=f.outbound.recoveryStatus().admissions[0].id,sessionId=f.agent.id,identity=f.replica.replicaHead(f.local).protected_hash
  const proof=await stopForAdmissionRecovery({ctx:f.ctx,agent:f.agent,closeRuntime:f.shutdown})
  f.lease.release('local',f.term);const term=f.lease.acquire('local').term
  f=await controllerQQ({storageFixture:{...f.storageFixture,term},resumeSessionId:sessionId})
  assert.equal((await f.hub.recoverAdmission({id,proof})).state,'ready');assert.equal(f.requests.length,0)
  assert.equal((await f.hub.recoverAdmission({id,proof,dryRun:false})).submitted,true)
  await f.settle();assert.deepEqual(f.errors,[]);assert.equal(f.sent.length,1)
  assert.ok(f.read("SELECT id FROM memories WHERE content LIKE '%恢复风铃%'").length>0)
  assert.equal(f.replica.replicaHead(f.local).protected_hash,identity)
  assert.equal((await f.hub.recoverAdmission({id,proof,dryRun:false})).state,'accepted')
  await f.hub.onMessage(e);assert.equal(f.sent.length,1)
 }finally{await f.cleanup()}
})

import {appendFileSync} from 'node:fs'
test('nonempty original history prefix is preserved across clean recovery',async()=>{
 let {f,id}=await missing({prior:true})
 try{
  const r=await restart(f);f=r.fresh
  const result=await r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false});assert.equal(result.submitted,true)
  for(let i=0;i<200&&f.agent.status!=='idle';i++)await new Promise(r=>setTimeout(r,5))
  assert.deepEqual(f.errors,[])
  assert.equal(f.agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id==='prior-synthetic-turn').length,1)
 }finally{await f.cleanup()}
})
test('torn physical tail cannot be interpreted as proof of absence',async()=>{
 let {f,id}=await missing()
 try{
  const r=await restart(f);f=r.fresh
  appendFileSync(f.ctx.sessionPersistence.locate(f.agent.session.header).path,'{')
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}),/physical history|absence|checkpoint/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
test('expired authority stops recovery before native followup',async()=>{
 let {f,id}=await missing()
 try{
  const r=await restart(f);f=r.fresh;f.lease.release('local',f.term)
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}),/FENCED/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
test('expired retained input bodies are purged idempotently while identity and audit survive',async()=>{
 let {f,out,id}=await missing()
 try{
  const db=f.lease.openAuthority();try{db.exec('UPDATE tide_input_journal SET expires_at=0; UPDATE tide_input_payloads SET expires_at=0')}finally{db.close()}
  assert.deepEqual(out.purgeExpiredInputs(),{removed:1,payloads:1});assert.deepEqual(out.purgeExpiredInputs(),{removed:0,payloads:0})
  assert.equal(out.recoveryStatus().admissions[0].id,id)
  const r=await restart(f);f=r.fresh
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}),/expired|missing/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
test('original history checkpoint conflict stops recovery before dispatch',async()=>{
 let {f,id}=await missing()
 try{
  const r=await restart(f);f=r.fresh
  const db=f.lease.openAuthority();try{db.prepare('UPDATE tide_input_payloads SET baseline_hash=? WHERE id=?').run('0'.repeat(64),id)}finally{db.close()}
  await assert.rejects(r.out.recoverAdmission({id,ctx:f.ctx,agent:f.agent,proof:r.proof,dryRun:false}),/prefix missing|rolled back/)
  assert.equal(f.requests.length,0)
 }finally{await f.cleanup()}
})
