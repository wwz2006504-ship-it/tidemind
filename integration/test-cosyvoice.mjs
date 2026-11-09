import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import voice from '../host/aurabot/src/modules/voice/index.js'
import {buildWav} from '../host/aurabot/src/voice/wav.js'
import {bindCloudCosyVoice,createCosyVoiceBridge} from './cosyvoice-bridge.mjs'
import {aurabotHost} from './aurabot-host-fixture.mjs'
const pcm=Buffer.alloc(1000),reference=buildWav(new Int16Array(600),22050)

test('reviewed cloud reference uses the owned loopback service and rejects drift before transport',async()=>{
 const f=await aurabotHost(),originalFetch=globalThis.fetch
 try{
  const refAudio=join(f.root,'cloud-reference.wav');writeFileSync(refAudio,reference)
  const policy={root:f.root,url:'http://127.0.0.1:50000',refAudio,referenceSha256:createHash('sha256').update(reference).digest('hex')}
  assert.throws(()=>bindCloudCosyVoice({...policy,url:'http://192.0.2.1:50000'}),/loopback/)
  const cloudVoice=bindCloudCosyVoice(policy)
  const bridge=createCosyVoiceBridge({getConfig:()=>({voice:{engine:'cosyvoice',cosyvoice:{mode:'cross_lingual',refAudio:'unreviewed-path',url:'http://192.0.2.1:50000'}}}),isLocal:()=>false,cloudVoice})
  let calls=0
  globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,policy.url+'/inference_cross_lingual');assert.equal(init.redirect,'error');assert.deepEqual(Buffer.from(await init.body.get('prompt_wav').arrayBuffer()),reference);return {ok:true,arrayBuffer:async()=>new Uint8Array(pcm).buffer}}
  assert.equal((await bridge.speak('SYNTHETIC')).engine,'cosyvoice')
  writeFileSync(refAudio,'changed');await assert.rejects(bridge.speak('SYNTHETIC'),/differs from reviewed hash/);assert.equal(calls,1)
 }finally{globalThis.fetch=originalFetch;await f.cleanup()}
})

test('original CosyVoice cross_lingual protocol reaches original Hub record output in real host, preserving reference and audio rate',async()=>{
 const originalFetch=globalThis.fetch;const requests=[]
 globalThis.fetch=async(url,init)=>{requests.push({url,init});assert.equal(url,'http://127.0.0.1:50000/inference_cross_lingual');return {ok:true,arrayBuffer:async()=>pcm.buffer.slice(pcm.byteOffset,pcm.byteOffset+pcm.byteLength)}}
 const configPatch={voice:{enabled:true,engine:'cosyvoice',autoChance:0,cosyvoice:{url:'http://127.0.0.1:50000',mode:'cross_lingual',refAudio:'',sampleRate:22050,speed:'1'}}}
 let ref;let f
 try{
  f=await aurabotHost({mode:'voice-reply',builtins:[voice],configPatch,prepareModules:async({f})=>{ref=join(f.root,'synthetic-reference.wav');writeFileSync(ref,reference);configPatch.voice.cosyvoice.refAudio=ref;return {}}})
  await f.emit(f.event(13001,'SYNTHETIC VOICE REQUEST'));await f.settle()
  assert.equal(requests.length,1);assert.equal(requests[0].init.method,'POST')
  const form=requests[0].init.body;assert.equal(form.get('tts_text'),'合成 CosyVoice 声音');assert.equal(form.has('prompt_text'),false)
  assert.deepEqual(Buffer.from(await form.get('prompt_wav').arrayBuffer()),reference)
  assert.deepEqual(readFileSync(ref),reference)
  const record=f.sent[0].params.message[0];assert.equal(record.type,'record')
  const audio=Buffer.from(record.data.file.slice(9),'base64');assert.equal(audio.toString('ascii',0,4),'RIFF');assert.equal(audio.readUInt32LE(24),22050);assert.deepEqual(audio.subarray(44),pcm)
  await f.emit(f.event(13001,'SYNTHETIC VOICE REQUEST'));assert.equal(f.sent.length,1);assert.equal(requests.length,1)
 }finally{try{if(f)await f.cleanup()}finally{globalThis.fetch=originalFetch}}
})

test('CosyVoice bridge forwards mode, reference, speed and prompt without mutating configuration; no substitute engine accepted',async()=>{
 const cfg={voice:{engine:'cosyvoice',cosyvoice:{url:'http://synthetic.invalid',mode:'zero_shot',refAudio:'/synthetic/ref.wav',promptText:'SYNTHETIC REFERENCE',speed:'1.1',sampleRate:24000}}},before=structuredClone(cfg)
 let seen
 const bridge=createCosyVoiceBridge({getConfig:()=>cfg,synthesize:async(text,opt)=>{seen=opt;return {file:'/synthetic/result.wav',engine:'cosyvoice'}}})
 await bridge.speak('SYNTHETIC');assert.equal(seen.requireRequestedEngine,true);assert.deepEqual(seen.cosyvoice,before.voice.cosyvoice);assert.deepEqual(cfg,before)
 const wrong=createCosyVoiceBridge({getConfig:()=>cfg,synthesize:async()=>({file:'wrong.wav',engine:'windows'})})
 await assert.rejects(wrong.speak('SYNTHETIC'),/CosyVoice did not confirm/)
})

test('shared candidate voice module delegates preview and synthesis to same CosyVoice binding',async()=>{
 let count=0;const routes=new Map(),bridge={speak:async text=>{count++;return {file:'synthetic.wav',engine:'cosyvoice'}}}
 const result=voice.setup({core:{voiceTTS:bridge,hub:{},onebot:{},local:{},http:{}},route:(p,h)=>routes.set(p,h),config:()=>({voice:{engine:'cosyvoice'}})})
 assert.equal((await result.speak('SYNTHETIC')).engine,'cosyvoice');assert.equal(count,1);assert.ok(routes.has('/voice/test'))
})

test('rest aborts a pending CosyVoice HTTP request in autonomous reply without text fallback or a second voice engine',async()=>{
 const originalFetch=globalThis.fetch;let signal,started=false,f
 globalThis.fetch=async(url,init)=>{assert.equal(url,'http://127.0.0.1:50000/inference_cross_lingual');signal=init.signal;started=true;return new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})})}
 const configPatch={voice:{enabled:true,engine:'cosyvoice',autoChance:0,cosyvoice:{url:'http://127.0.0.1:50000',mode:'cross_lingual',refAudio:'',sampleRate:22050}}}
 try{
  f=await aurabotHost({mode:'voice-reply',builtins:[voice,{id:'voice-abort-test',setup(api){api.every(60000,()=>api.core.hub.pushToSession({chatId:'private:20001',kind:'private',userId:'20001'},[{type:'text',text:'SYNTHETIC VOICE ACTIVITY'}],''));return {}}}],configPatch,prepareModules:async({f})=>{const file=join(f.root,'synthetic-reference.wav');writeFileSync(file,reference);configPatch.voice.cosyvoice.refAudio=file;return {}}})
  await f.supervisor.setRest(false,{op:'voice-wake'});const pending=f.activityCallbacks.find(r=>r.moduleId==='voice-abort-test').run()
  for(let i=0;i<200&&!started;i++)await new Promise(r=>setTimeout(r,5));assert.equal(started,true)
  const stopped=await f.supervisor.setRest(true,{op:'voice-sleep'});assert.equal(stopped.drained,true)
  assert.equal(signal.aborted,true);assert.equal((await pending).state,'needs_review');assert.equal(f.sent.length,0)
 }finally{try{if(f)await f.cleanup()}finally{globalThis.fetch=originalFetch}}
})

test('cloud context cannot invoke local CosyVoice or read its reference through the voice binding',async()=>{
 let called=0
 const bridge=createCosyVoiceBridge({getConfig:()=>({voice:{engine:'cosyvoice'}}),isLocal:()=>false,synthesize:async()=>{called++;return {file:'synthetic.wav',engine:'cosyvoice'}}})
 await assert.rejects(bridge.speak('SYNTHETIC'),/cloud context/);assert.equal(called,0)
})
