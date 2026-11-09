import {test} from 'node:test'
import assert from 'node:assert/strict'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {createRemoteSourceAdmission} from './remote-source-admission.mjs'
import {createRemoteQQ} from './remote-qq.mjs'
const event={post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:73001,message:[{type:'text',data:{text:'SYNTHETIC SOURCE'}}]},msg={chatId:'private:20001',messageId:'73001',userId:'20001'}
async function fixture(intercept){const f=await authorityHttpFixture({qqConfig:{selfId:10001,allowTargets:['private:20001'],transport:async()=>assert.fail('no sends')}}),authority={request:(path,body)=>intercept?intercept(path,body,f.local):f.local.request(path,body)},source=createRemoteSourceAdmission({authority,term:f.term}),qq=createRemoteQQ({authority,term:f.term,selfId:10001,sourceContext:source.currentCallback});return {...f,source,qq}}
test('whole remote callback remains counted while pause starts; prior admitted event can finish',async()=>{const f=await fixture();let release;try{
 let started=false;const hold=new Promise(r=>release=r),work=f.source.dispatch(event,async()=>{started=true;await hold;assert.equal((await f.qq.observeInbound(event,msg)).admitted,true)})
 for(let i=0;i<100&&!started;i++)await new Promise(r=>setTimeout(r,5));assert.equal(started,true);await f.source.pause('source-pause')
 assert.equal((await f.source.status()).durableActive,1);release();await work;assert.equal((await f.source.drain()).durableActive,0)
 let duplicate=false;await f.source.dispatch(event,()=>duplicate=true);assert.equal(duplicate,false)
 const next=await f.source.dispatch({...event,message_id:73002},()=>assert.fail('must defer'));assert.equal(next.deferred,true)
}finally{release?.();await f.cleanup()}})
test('lost source begin response never invokes client callback and retains durable uncertainty',async()=>{let lose=true;const f=await fixture(async(path,body,client)=>{const value=await client.request(path,body);if(path==='/qq/source/begin'&&lose){lose=false;throw Error('SYNTHETIC BEGIN LOST')}return value});try{
 await assert.rejects(f.source.dispatch(event,()=>assert.fail('never admitted locally')),/BEGIN LOST/);assert.equal((await f.source.status()).durableActive,1)
 await assert.rejects(f.source.dispatch(event,()=>assert.fail('must not retry callback')),/requires review/)
 await assert.rejects(f.source.drain(),/unresolved/)
}finally{await f.cleanup()}})
test('lost finish ACK is recovered by reading canonical completion without redoing callback',async()=>{let lose=true,calls=0;const f=await fixture(async(path,body,client)=>{const value=await client.request(path,body);if(path==='/qq/source/finish'&&lose){lose=false;throw Error('SYNTHETIC FINISH LOST')}return value});try{
 await f.source.dispatch(event,()=>calls++);assert.equal(calls,1);assert.equal((await f.source.drain()).clientFailures,0)
 await f.source.dispatch(event,()=>calls++);assert.equal(calls,1)
}finally{await f.cleanup()}})
test('failed remote callback retains review state and cannot resume or seal silently',async()=>{const f=await fixture();try{
 await assert.rejects(f.source.dispatch(event,()=>{throw Error('SYNTHETIC CALLBACK FAILED')}),/CALLBACK FAILED/);await f.source.pause('review-source')
 assert.equal((await f.source.status()).uncertain,1);await assert.rejects(f.source.resume('review-source'),e=>e.status===409);await assert.rejects(f.source.drain(),/unresolved/)
}finally{await f.cleanup()}})
test('remote deferred replay keeps actual arrival order, original event and live callback binding',async()=>{const f=await fixture();try{
 await f.source.pause('remote-replay');for(const n of [3,1,2])await f.source.dispatch({...event,message_id:73000+n},()=>assert.fail('paused'))
 const seen=[];const result=await f.source.replay('remote-replay',async raw=>{seen.push(raw.message_id);const value=await f.qq.observeInbound(raw,{...msg,messageId:String(raw.message_id)});assert.equal(value.admitted,true)})
 assert.equal(result.forwarded,3);assert.deepEqual(seen,[73003,73001,73002]);assert.equal(result.durableActive,0)
 assert.equal((await f.source.replay('remote-replay',()=>assert.fail('no repeats'))).forwarded,0);await f.source.resume('remote-replay')
}finally{await f.cleanup()}})
