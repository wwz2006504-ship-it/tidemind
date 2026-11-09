import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {remoteRuntimeFixture} from './remote-runtime-fixture.mjs'
import {assertCloudConfig} from './cloud-host-policy.mjs'
import {defineTool} from '../host/aurabot/src/tools/tools.js'
test('same original cloud holder chats with unchanged identity and cannot execute late-added local computer tool',async()=>{
 const f=await remoteRuntimeFixture({cloud:true});let off;try{
  const before=readFileSync(join(f.paths.sourceDataRoot,'personas/synthetic.md')),r=await f.start()
  await f.emit(f.event(79601));for(let i=0;i<300&&(f.agent.status!=='idle'||!f.remoteSent.length);i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(f.remoteSent.length,1);assert.equal(f.sent.length,0);assert.equal(r.host.getConfig().persona.current,'synthetic')
  const prompt=await f.ctx.systemPrompt.assemble({scope:f.agent,agent:f.agent});assert.match(JSON.stringify(prompt),/当前运行在云端/)
  let calls=0;off=f.ctx.tools.register(defineTool({name:'synthetic_local_pc',description:'SYNTHETIC ONLY',properties:{},required:[],execute:()=>{calls++;return {ok:true}}}))
  const result=await f.agent.ctx.tools.execute({name:'synthetic_local_pc',arguments:{},callId:'cloud-pc-attempt',agent:f.agent,signal:new AbortController().signal})
  assert.equal(result.isError,true);assert.equal(calls,0)
  assert.ok(!r.host.modules.running('pet-link'));assert.ok(!r.host.modules.running('imagegen'))
  assert.deepEqual(readFileSync(join(f.paths.sourceDataRoot,'personas/synthetic.md')),before);assert.deepEqual(f.errors,[])
 }finally{off?.();await f.cleanup()}
})
test('cloud config updates cannot silently re-enable local module loading or desktop mirroring',async()=>{
 const f=await remoteRuntimeFixture({cloud:true});try{
  const r=await f.start(),cfg=r.host.getConfig()
  assert.throws(()=>assertCloudConfig({...cfg,safeMode:false}),/cloud chat\/memory policy/)
  assert.throws(()=>assertCloudConfig({...cfg,petMirror:true}),/cloud chat\/memory policy/)
  const route=f.routes.get('/aurabot/api'),before=readFileSync(join(f.paths.dataRoot,'config.json'))
  let result;const body=JSON.stringify({safeMode:false});await route.handler({url:'/aurabot/api/config',method:'POST',async *[Symbol.asyncIterator](){yield Buffer.from(body)}},{setHeader(){},end(value){result=JSON.parse(value)}})
  assert.equal(result.ok,false);assert.deepEqual(readFileSync(join(f.paths.dataRoot,'config.json')),before)
 }finally{await f.cleanup()}
})
