import test from 'node:test'
import assert from 'node:assert/strict'
import {qqFixture} from './qq-fixture.mjs'
import {createQQOutbound} from './qq-outbound.mjs'
function args(f,origin,extra={}){return {sessionId:f.agent.id,chatId:'private:20001',origins:[origin],content:[{type:'text',text:'synthetic'}],followup:async()=>{},flush:async()=>{},...extra}}
test('input journal persists before Hub followup; restart reports queue without replay',async()=>{
 const f=await qqFixture();try{f.observe(f.event());const restart=createQQOutbound({...f,holder:'local',selfId:'10001',allowTargets:['private:20001'],transport:async()=>assert.fail()});const state=restart.recoveryStatus();assert.equal(state.queued.length,1);assert.equal(state.automaticReplay,false);assert.equal(f.admissions.length,0);assert.equal(restart.observeInbound(f.event(),{chatId:'private:20001',userId:'20001',messageId:'101'}).admitted,false)}finally{await f.cleanup()}
})
test('successful flush remains explicitly unverified and retry never invokes followup',async()=>{
 const f=await qqFixture();try{const {origin}=f.observe(f.event());let calls=0;const a=args(f,origin,{followup:async()=>calls++});assert.equal((await f.outbound.admitInput(a)).state,'flushed_unverified');await assert.rejects(f.outbound.admitInput(a),/already attempted/);assert.equal(calls,1);assert.equal(f.outbound.recoveryStatus().queued.length,0)}finally{await f.cleanup()}
})
test('flush failure preserves uncertain admission and blocks repeat',async()=>{
 const f=await qqFixture();try{const {origin}=f.observe(f.event());let calls=0;const a=args(f,origin,{followup:async()=>calls++,flush:async()=>{throw Error('disk failure')}});await assert.rejects(f.outbound.admitInput(a),/interrupted/);assert.equal(f.outbound.recoveryStatus().admissions[0].state,'dispatching');await assert.rejects(f.outbound.admitInput(a),/already attempted/);assert.equal(calls,1)}finally{await f.cleanup()}
})
test('changed admission content and overlapping origin cannot create another delivery',async()=>{
 const f=await qqFixture();try{const {origin}=f.observe(f.event());await f.outbound.admitInput(args(f,origin));await assert.rejects(f.outbound.admitInput(args(f,origin,{content:[]})),/conflict/);await assert.rejects(f.outbound.admitInput(args(f,origin,{sessionId:'another-session'})),/already assigned/)}finally{await f.cleanup()}
})
test('expiry removes raw event body idempotently while retaining dedup identity',async()=>{
 const f=await qqFixture();try{const {origin}=f.observe(f.event());const db=f.lease.openAuthority();try{db.prepare('UPDATE tide_input_journal SET expires_at=0 WHERE origin=?').run(origin)}finally{db.close()};assert.equal(f.outbound.purgeExpiredInputs().removed,1);assert.equal(f.outbound.purgeExpiredInputs().removed,0);assert.equal(f.observe(f.event()).duplicate,true);await assert.rejects(f.outbound.admitInput(args(f,origin)),/expired/);assert.equal(f.outbound.recoveryStatus().queued[0].state,'expired')}finally{await f.cleanup()}
})
test('actual original Hub uses stable admission id and does not call flush failure success',async()=>{
 const f=await qqFixture();try{await f.hub.onMessage(f.event());await f.waitAdmissions(1);assert.match(f.admissions[0].id,/^tide-input-/);for(let i=0;i<20&&f.outbound.recoveryStatus().admissions[0]?.state==='dispatching';i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.outbound.recoveryStatus().admissions[0].state,'flushed_unverified')}finally{await f.cleanup()}
})
