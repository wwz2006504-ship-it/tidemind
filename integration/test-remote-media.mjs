import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {createRemoteQQ} from './remote-qq.mjs'
const image=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(100000,17)]),audio=Buffer.concat([Buffer.from('RIFF0000WAVEfmt '),Buffer.alloc(70000,5)])
async function setup({intercept,transport}={}){
 const packets=[],f=await authorityHttpFixture({qqConfig:{selfId:10001,allowTargets:['private:20001'],mediaProtocol:'immutable-upload-v1',transport:transport|| (async(action,params)=>{packets.push({action,params});return {message_id:packets.length+90000}})}})
 const root=join(f.root,'client-media');mkdirSync(root);const authority={request:(path,body)=>intercept?intercept(path,body,f.local):f.local.request(path,body)},qq=createRemoteQQ({authority,term:f.term,selfId:10001,mediaRoot:root})
 const input=await qq.observeInbound({post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:72001,message:[{type:'text',data:{text:'SYNTHETIC MEDIA'}}]},{chatId:'private:20001',messageId:'72001',userId:'20001'})
 const binding={sessionId:'synthetic-media',turn:1,chatId:'private:20001',origins:[input.origin],replyIdentity:'SYNTHETIC FINAL MEDIA'};await qq.bindTurn(binding)
 return {...f,qq,binding,packets}
}
const capture=()=>({sent:[{chatId:'private:20001',message:[{type:'image',data:{file:'base64://'+image.toString('base64')}}]},{chatId:'private:20001',message:[{type:'record',data:{file:'base64://'+audio.toString('base64')}}]}],result:[{kind:'image',value:'SYNTHETIC IMAGE'},{kind:'voice',value:'SYNTHETIC VOICE'}]})
test('remote image and record use immutable chunk staging and do not rerender after accepted send',async()=>{const f=await setup();let rendered=0;try{
 assert.equal((await f.qq.reply(f.binding,async()=>{rendered++;return capture()})).state,'sent');assert.equal(f.packets.length,2)
 assert.equal(f.packets[0].params.message[0].data.file,'base64://'+image.toString('base64'));assert.equal(f.packets[1].params.message[0].data.file,'base64://'+audio.toString('base64'))
 assert.equal((await f.qq.reply(f.binding,async()=>assert.fail('must not regenerate TTS'))).attempted,false);assert.equal(rendered,1)
}finally{await f.cleanup()}})
test('lost chunk acknowledgement resumes staged bytes before any QQ send',async()=>{let lost=false,chunks=0;const f=await setup({intercept:async(path,body,client)=>{const value=await client.request(path,body);if(path==='/qq/media/chunk'){chunks++;if(!lost){lost=true;throw Error('SYNTHETIC CHUNK ACK LOST')}}return value}});try{
 await assert.rejects(f.qq.reply(f.binding,async()=>capture()),/CHUNK ACK LOST/);assert.equal(f.packets.length,0)
 assert.equal((await f.qq.reply(f.binding,async()=>capture())).state,'sent');assert.equal(f.packets.length,2);assert.equal(chunks,7)
}finally{await f.cleanup()}})
test('media body hash, type and old term cannot be bypassed',async()=>{const f=await setup();try{
 const info={id:'a'.repeat(64),type:'image',bytes:8};await f.local.request('/qq/media/begin',{...info,term:f.term})
 await f.local.request('/qq/media/chunk',{...info,term:f.term,offset:0,data:Buffer.from('NOTIMAGE').toString('base64')})
 await assert.rejects(f.local.request('/qq/media/complete',{...info,term:f.term}),e=>e.status===409)
 await f.local.request('/admin',{command:'release',term:f.term});await f.local.request('/admin',{command:'acquire'})
 await assert.rejects(f.local.request('/qq/media/begin',{...info,term:f.term}),e=>e.status===409)
}finally{await f.cleanup()}})
test('unknown media delivery freezes outcome and never regenerates or resends',async()=>{let attempts=0;const f=await setup({transport:async()=>{attempts++;throw Error('SYNTHETIC ONEBOT LOST')}});try{
 assert.equal((await f.qq.reply(f.binding,async()=>capture())).state,'unknown');assert.equal(attempts,1)
 const result=await f.qq.reply(f.binding,async()=>assert.fail('unknown media may not rerender'));assert.equal(result.state,'unknown');assert.equal(result.attempted,false);assert.equal(attempts,1)
}finally{await f.cleanup()}})
