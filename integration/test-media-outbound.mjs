import test from 'node:test'
import assert from 'node:assert/strict'
import {writeFileSync,readFileSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {qqFixture} from './qq-fixture.mjs'
import {createOneBotCapabilities} from './onebot-capabilities.mjs'
import {createHub} from '../host/aurabot/src/chat/hub.js'
import {buildWav} from '../host/aurabot/src/voice/wav.js'
import qqTools from '../host/aurabot/src/modules/qq-tools/index.js'
const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(32)])
const wav=buildWav(new Int16Array(500),22050)
async function fixture({transport,beforeDispatch}={}){
 const f=await qqFixture(),calls=[]
 const gateway={...f.gateway,dispatch:async(...args)=>{if(beforeDispatch)beforeDispatch(f);return f.gateway.dispatch(...args)}}
 const c=createOneBotCapabilities({...f,gateway,selfId:10001,allowTargets:['private:20001','private:20002','group:30001'],authorize:()=>assert.fail('must not ask approval'),transport:async(action,params,options)=>{calls.push({action,params,options});return transport?transport(action,params):{message_id:1000+calls.length}}})
 let syntheses=0;const file=join(f.root,'synthetic-voice.wav');writeFileSync(file,wav);f.cfg.voice.enabled=true
 const hub=createHub({dsh:f.ctx,getConfig:()=>f.cfg,log:{info(){},warn(){},debug(){},error(){}},onebot:c.moduleClient,outbound:c.outbound,stickers:{},tts:{speak:async()=>{syntheses++;return {file,engine:'cosyvoice'}}}})
 const event=f.event();const {origin}=c.outbound.observeInbound(event,{chatId:'private:20001',messageId:'101',userId:'20001'})
 const binding={sessionId:f.agent.id,turn:1,chatId:'private:20001'};c.outbound.bindTurn({...binding,origins:[origin]});f.agent.turn=1
 const tool=(fn,callId='media-call')=>c.wrapAutonomousTool({execute:fn}).execute({},{agent:f.agent,callId})
 return {f,c,hub,calls,file,binding,tool,syntheses:()=>syntheses,cleanup:async()=>{await c.outbound.idle();hub.dispose();await f.cleanup()}}
}

test('bound tool image sends once, replays real receipt, and stores blob references rather than base64 in outbox',async()=>{
 const h=await fixture();try{
  const message=[{type:'image',data:{file:'base64://'+png.toString('base64')}}]
  const first=await h.tool(()=>h.hub.sendSegments('private:20001',message,'synthetic'))
  const again=await h.tool(()=>h.hub.sendSegments('private:20001',message,'synthetic'))
  assert.equal(first.message_id,again.message_id);assert.equal(again.replayed,true);assert.equal(h.calls.length,1)
  assert.equal(h.calls[0].params.message[0].type,'image');assert.equal(h.calls[0].options.singleAttempt,true)
  const db=h.f.lease.openAuthority();try{const payload=db.prepare('SELECT payload FROM tide_outbox').get().payload;assert.ok(!payload.includes('base64://'));assert.ok(payload.includes('blob'))}finally{db.close()}
 }finally{await h.cleanup()}
})

test('original Hub voice file emits record with preserved WAV bytes and does not repeat on replay',async()=>{
 const h=await fixture();try{
  await h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file,'synthetic'))
  await h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file,'synthetic'))
  assert.equal(h.calls.length,1);const segment=h.calls[0].params.message[0]
  assert.equal(segment.type,'record');assert.deepEqual(Buffer.from(segment.data.file.slice(9),'base64'),wav)
 }finally{await h.cleanup()}
})

test('final voice reply has stable identity and replay does not rerun synthesis',async()=>{
 const h=await fixture();try{
  const binding={...h.binding,replyIdentity:'<voice>SYNTHETIC VOICE</voice>'}
  const render=()=>h.hub.capture(()=>h.hub.deliver(binding.chatId,binding.replyIdentity,{simulate:true}))
  assert.equal((await h.c.outbound.reply(binding,render)).state,'sent')
  assert.equal((await h.c.outbound.reply(binding,render)).attempted,false)
  assert.equal(h.syntheses(),1);assert.equal(h.calls.length,1);assert.equal(h.calls[0].params.message[0].type,'record')
  await assert.rejects(h.c.outbound.reply({...binding,replyIdentity:'changed'},render),/identity conflict/)
 }finally{await h.cleanup()}
})

test('voice ACK loss never falls back to another text send or resends through a fresh tool call',async()=>{
 const h=await fixture({transport:async()=>{throw Error('synthetic ACK lost')}});try{
  await assert.rejects(h.tool(()=>h.hub.sendVoice('private:20001','SYNTHETIC VOICE')),/unconfirmed/)
  await assert.rejects(h.tool(()=>h.hub.sendVoice('private:20001','SYNTHETIC VOICE')),/unconfirmed/)
  await assert.rejects(h.tool(()=>h.hub.sendVoice('private:20001','SYNTHETIC VOICE'),'fresh-call'),/unconfirmed/)
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].params.message[0].type,'record')
  assert.equal(h.syntheses(),1)
  assert.equal(h.c.outbound.audit().outbox[0].state,'unknown')
 }finally{await h.cleanup()}
})

test('changed media under same call ID conflicts; unbound and unapproved targets cannot send',async()=>{
 const h=await fixture();try{
  await assert.rejects(h.hub.sendSegments('private:20001',[{type:'image',data:{file:'base64://'+png.toString('base64')}}]),/unbound/)
  await h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file))
  const other=Buffer.from(wav);other[other.length-1]=1;writeFileSync(h.file,other)
  await assert.rejects(h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file)),/conflict/)
  await assert.rejects(h.tool(()=>h.hub.sendText('private:99999','synthetic')),/target/)
  assert.equal(h.calls.length,1)
 }finally{await h.cleanup()}
})

test('blob changed after enqueue is not transmitted and remains unconfirmed',async()=>{
 const h=await fixture({beforeDispatch:f=>{const db=f.lease.openAuthority();try{const value=JSON.parse(db.prepare('SELECT payload FROM tide_outbox').get().payload);const id=value.requests[0].params.message[0].data.file.blob;writeFileSync(join(f.root,'media-outbox',id+'.blob'),Buffer.from('TAMPERED'))}finally{db.close()}}})
 try{
  await assert.rejects(h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file)),/unconfirmed/)
  assert.equal(h.calls.length,0);assert.equal(h.c.outbound.audit().outbox[0].state,'unknown')
 }finally{await h.cleanup()}
})

test('original qq_send_message tool uses bound outbox in actual ToolRuntime and final reply remains a separate single slot',async()=>{
 const h=await fixture();try{
  let builder;qqTools.setup({core:{hub:h.hub,onebot:h.c.moduleClient},tool:b=>{builder=b},config:()=>h.f.cfg})
  const t=builder({chat:{kind:'private',chatId:'private:20001',userId:'20001'},level:'full'}).find(t=>t.name==='qq_send_message')
  const off=h.f.agent.ctx.tools.register(h.c.wrapAutonomousTool(t))
  try{const result=await h.f.call(t.name,{target:'private:20002',text:'SYNTHETIC TOOL MESSAGE'},'native-qq-send');assert.equal(result.value.ok,true)}finally{off()}
  const render=()=>h.hub.capture(()=>h.hub.deliver('private:20001','SYNTHETIC FINAL',{simulate:true}))
  await h.c.outbound.reply({...h.binding,replyIdentity:'SYNTHETIC FINAL'},render)
  await h.c.outbound.reply({...h.binding,replyIdentity:'SYNTHETIC FINAL'},render)
  assert.equal(h.calls.length,2);assert.equal(h.calls[0].params.user_id,20002);assert.equal(h.calls[1].params.user_id,20001)
 }finally{await h.cleanup()}
})

test('queued voice uses frozen bytes even if source audio file changes before transport',async()=>{
 const changed=Buffer.from(wav);changed[changed.length-1]=3
 const h=await fixture({beforeDispatch:f=>writeFileSync(join(f.root,'synthetic-voice.wav'),changed)})
 try{
  await h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file))
  assert.deepEqual(Buffer.from(h.calls[0].params.message[0].data.file.slice(9),'base64'),wav)
 }finally{await h.cleanup()}
})

test('invalid media type, remote files and oversized media are rejected before any QQ transmission',async()=>{
 const h=await fixture();try{
  const send=file=>h.tool(()=>h.hub.sendSegments('private:20001',[{type:'record',data:{file}}]))
  await assert.rejects(send('base64://'+png.toString('base64')),/format/)
  await assert.rejects(send('https://synthetic.invalid/audio.wav'),/remote media/)
  const huge=Buffer.alloc(17*1024*1024);wav.copy(huge)
  await assert.rejects(send('base64://'+huge.toString('base64')),/size/)
  assert.equal(h.calls.length,0);assert.equal(h.c.outbound.audit().outbox.length,0)
 }finally{await h.cleanup()}
})

test('reinitialized media capability reuses persisted receipt and blob without another transport',async()=>{
 const h=await fixture();try{
  const first=await h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file))
  let repeated=0;const fresh=createOneBotCapabilities({...h.f,selfId:10001,allowTargets:['private:20001','private:20002','group:30001'],transport:async()=>{repeated++;return {message_id:9999}}})
  const result=await fresh.wrapAutonomousTool({execute:()=>fresh.outbound.send({chatId:'private:20001',message:[{type:'record',data:{file:'base64://'+wav.toString('base64')}}]})}).execute({},{agent:h.f.agent,callId:'media-call'})
  assert.equal(result.message_id,first.message_id);assert.equal(result.replayed,true);assert.equal(repeated,0);await fresh.outbound.idle()
 }finally{await h.cleanup()}
})

test('partial media reply retains sent and unknown receipts; replay never rerenders or resends any part',async()=>{
 let calls=0,renders=0
 const h=await fixture({transport:async()=>{if(++calls===2)throw Error('synthetic ACK loss');return {message_id:2201}}})
 try{
  const binding={...h.binding,replyIdentity:'SYNTHETIC MEDIA BATCH'}
  const render=async()=>{renders++;return {result:[{kind:'image'},{kind:'voice'}],sent:[{chatId:binding.chatId,message:[{type:'image',data:{file:'base64://'+png.toString('base64')}}]},{chatId:binding.chatId,message:[{type:'record',data:{file:'base64://'+wav.toString('base64')}}]}]}}
  assert.equal((await h.c.outbound.reply(binding,render)).state,'unknown')
  assert.deepEqual(h.c.outbound.audit().parts.map(p=>p.state),['sent','unknown'])
  assert.equal((await h.c.outbound.reply(binding,render)).attempted,false)
  assert.equal(renders,1);assert.equal(calls,2)
 }finally{await h.cleanup()}
})

test('group sticker retains original subtype and summary while using same bound media queue',async()=>{
 const h=await fixture();try{
  await h.tool(()=>h.hub.sendSegments('group:30001',[{type:'image',data:{file:'base64://'+png.toString('base64'),sub_type:1,summary:'[SYNTHETIC STICKER]'}}]))
  const packet=h.calls[0];assert.equal(packet.action,'send_group_msg');assert.equal(packet.params.group_id,30001)
  assert.equal(packet.params.message[0].data.sub_type,1);assert.equal(packet.params.message[0].data.summary,'[SYNTHETIC STICKER]')
 }finally{await h.cleanup()}
})

test('unknown tool voice cannot be resent as a media final reply for the same input turn',async()=>{
 const h=await fixture({transport:async()=>{throw Error('synthetic ACK lost')}});try{
  await assert.rejects(h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file)),/unconfirmed/)
  const render=async()=>({result:[{kind:'voice'}],sent:[{chatId:h.binding.chatId,message:[{type:'record',data:{file:'base64://'+wav.toString('base64')}}]}]})
  await assert.rejects(h.c.outbound.reply({...h.binding,replyIdentity:'SYNTHETIC RETRY'},render),/unconfirmed/)
  assert.equal(h.calls.length,1);assert.equal(h.c.outbound.audit().outbox.length,1)
 }finally{await h.cleanup()}
})

test('stable voice text intent reuses receipt before synthesis and changed text under same call conflicts',async()=>{
 const h=await fixture();try{
  assert.equal(await h.tool(()=>h.hub.sendVoice('private:20001','SYNTHETIC VOICE A')),true)
  assert.equal(await h.tool(()=>h.hub.sendVoice('private:20001','SYNTHETIC VOICE A')),true)
  assert.equal(h.syntheses(),1);assert.equal(h.calls.length,1)
  await assert.rejects(h.tool(()=>h.hub.sendVoice('private:20001','SYNTHETIC VOICE B')),/conflict/)
  assert.equal(h.syntheses(),1)
 }finally{await h.cleanup()}
})

test('new native tool turn cannot borrow an earlier turn binding to send media',async()=>{
 const h=await fixture();try{
  h.f.agent.turn=2
  await assert.rejects(h.tool(()=>h.hub.sendVoiceFile('private:20001',h.file)),/turn not bound/)
  assert.equal(h.calls.length,0)
 }finally{await h.cleanup()}
})
