import {test} from 'node:test'
import assert from 'node:assert/strict'
import {authorityHttpFixture,keys} from './authority-http-fixture.mjs'
import {controllerHost} from './controller-host.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
import {createRemoteQQ} from './remote-qq.mjs'
import {stopForAdmissionRecovery} from './admission-recovery.mjs'
async function setup(intercept){
 const network=await authorityHttpFixture({qqConfig:{selfId:10001,allowTargets:['private:20001'],transport:async()=>{throw Error('no outgoing transport in admission test')}}});let host
 try{host=await controllerHost({storageFixture:{...network,cleanup:()=>{}},mountMemory:false});const authority={request:async(path,body)=>intercept?intercept(path,body,network.local):network.local.request(path,body)},qq=createRemoteQQ({authority,term:network.term,selfId:10001,historyKey:keys.local,historyReader:createSessionHistoryReader(host.ctx.sessionPersistence)})
 const inbound=await qq.observeInbound({post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:71001,message:[{type:'text',data:{text:'SYNTHETIC INPUT'}}]},{chatId:'private:20001',messageId:'71001',userId:'20001'})
 let submitted=0;const input={sessionId:host.agent.id,chatId:'private:20001',origins:[inbound.origin],content:[{type:'text',text:'SYNTHETIC ACTUAL HISTORY'}],followup:async message=>{submitted++;host.agent.followup(message);for(let i=0;i<1000;i++){if(host.agent.status==='idle'&&host.agent.session.snapshotEvents().some(e=>e.type==='turn/end'))return;await new Promise(r=>setTimeout(r,5))}throw Error('synthetic agent did not settle')},flush:()=>host.ctx.sessions.flush(host.agent.session)}
 return {network,host,qq,input,submitted:()=>submitted,cleanup:async()=>{await host.cleanup();await network.cleanup()}}
 }catch(error){if(host)await host.cleanup();await network.cleanup();throw error}
}
test('remote original admission records actual DSH history and duplicate does not submit twice',async()=>{const f=await setup();try{
 assert.equal((await f.qq.admitInput(f.input)).state,'accepted');assert.equal((await f.qq.admitInput(f.input)).replayed,true);assert.equal(f.submitted(),1);assert.equal(f.host.requests.length,1)
 assert.equal((await f.qq.recoveryStatus()).admissions[0].state,'accepted')
}finally{await f.cleanup()}})
test('lost prepare response cannot automatically replay an unsubmitted local input',async()=>{let lose=true;const f=await setup(async(path,body,client)=>{const value=await client.request(path,body);if(path==='/qq/admission'&&body.phase==='before'&&lose){lose=false;throw Error('SYNTHETIC PREPARE RESPONSE LOST')}return value});try{
 await assert.rejects(f.qq.admitInput(f.input),/PREPARE RESPONSE LOST/);assert.equal(f.submitted(),0)
 await assert.rejects(f.qq.admitInput(f.input),e=>e.status===409);assert.equal(f.submitted(),0);assert.equal((await f.qq.recoveryStatus()).admissions[0].state,'dispatching')
}finally{await f.cleanup()}})
test('lost accepted reply recovers from native persisted history without another followup',async()=>{let lose=true;const f=await setup(async(path,body,client)=>{const value=await client.request(path,body);if(path==='/qq/admission'&&body.phase==='after'&&lose){lose=false;throw Error('SYNTHETIC CONFIRM RESPONSE LOST')}return value});try{
 await assert.rejects(f.qq.admitInput(f.input),/CONFIRM RESPONSE LOST/);assert.equal(f.submitted(),1)
 assert.equal((await f.qq.admitInput(f.input)).state,'accepted');assert.equal(f.submitted(),1)
}finally{await f.cleanup()}})
test('history signature binds actual descriptor, principal and phase before any submission',async()=>{let captured;const f=await setup(async(path,body,client)=>{if(path==='/qq/admission'){captured=structuredClone(body);throw Error('SYNTHETIC CAPTURE')}return client.request(path,body)});try{
 await assert.rejects(f.qq.admitInput(f.input),/SYNTHETIC CAPTURE/);assert.equal(f.submitted(),0)
 await assert.rejects(f.network.local.request('/qq/admission',{...captured,descriptor:{...captured.descriptor,content:[{type:'text',text:'FORGED'}]}}),e=>e.status===409)
 await assert.rejects(f.network.local.request('/qq/admission',{...captured,phase:'after'}),e=>e.status===409)
 await assert.rejects(f.network.cloud.request('/qq/admission',captured),e=>e.status===409)
 assert.equal((await f.qq.recoveryStatus()).admissions.length,0)
}finally{await f.cleanup()}})
test('remote recovery requires real clean stop, new native writer and newer term; replays same input once',async()=>{let lose=true,fresh;const f=await setup(async(path,body,client)=>{const value=await client.request(path,body);if(path==='/qq/admission'&&body.phase==='before'&&lose){lose=false;throw Error('SYNTHETIC LOST PLAN')}return value});try{
 await assert.rejects(f.qq.admitInput(f.input),/LOST PLAN/);const id=(await f.qq.recoveryStatus()).admissions[0].id
 await assert.rejects(f.qq.recoverAdmission({id,ctx:f.host.ctx,agent:f.host.agent,proof:{},dryRun:false}),/clean-stop proof/)
 const proof=await stopForAdmissionRecovery({ctx:f.host.ctx,agent:f.host.agent,closeRuntime:f.host.closeRuntime})
 await f.network.local.request('/admin',{command:'release',term:f.network.term});const grant=await f.network.local.request('/admin',{command:'acquire'})
 fresh=await controllerHost({storageFixture:{...f.network,term:grant.term,cleanup:()=>{}},mountMemory:false,resumeSessionId:f.host.agent.id})
 const qq=createRemoteQQ({authority:f.network.local,term:grant.term,selfId:10001,historyKey:keys.local,historyReader:createSessionHistoryReader(fresh.ctx.sessionPersistence)}),args={id,ctx:fresh.ctx,agent:fresh.agent,proof}
 assert.equal((await qq.recoverAdmission(args)).state,'ready');assert.equal(fresh.requests.length,0)
 assert.equal((await qq.recoverAdmission({...args,dryRun:false})).submitted,true)
 for(let i=0;i<200&&fresh.agent.status!=='idle';i++)await new Promise(r=>setTimeout(r,5));await fresh.ctx.sessions.flush(fresh.agent.session)
 assert.equal((await qq.recoverAdmission({...args,dryRun:false})).submitted,false)
 assert.equal(fresh.agent.session.snapshotEvents().filter(e=>e.type==='user/message'&&e.data.id===id).length,1)
}finally{if(fresh)await fresh.cleanup();await f.cleanup()}})
