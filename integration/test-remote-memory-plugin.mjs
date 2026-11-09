import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {fixture} from './fixture.mjs'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {controllerHost} from './controller-host.mjs'
import {createRemoteStoreExecutor} from './remote-store-executor.mjs'
import * as fenced from './fenced-store.mjs'
import * as memory from '../host/plugin/src/index.js'
test('real original memory tools in real Controller/AgentLoop commit through remote transport without local lease/gateway bindings',async()=>{
 const base=await fixture(raw=>raw.write({layer:'semantic',content:'合成检索标记 麦克风 调试约定',source:'tool'},1));let host,network,fiber
 try{
  host=await controllerHost({mode:'memory-tools',mountMemory:false,storageFixture:base});network=await authorityHttpFixture({storageFixture:base})
  const journal=join(base.root,'plugin-remote-journal');mkdirSync(journal);let commits=0
  const authority={request:async(path,body)=>{if(path==='/commit')commits++;return network.local.request(path,body)}}
  const executor=createRemoteStoreExecutor({authority,holder:'local',term:base.term,local:base.local,journalDirectory:journal,MemoryStore:base.MemoryStore})
  // Deliberately omit lease/gateway: any old synchronous shortcut must fail this test.
  fenced.configure({root:base.root,local:base.local,localDir:base.localDir,remoteStoreExecutor:executor,bindings:[{agentId:host.agent.id,sessionId:host.agent.id,logicalAgentId:'xiyu'}]})
  fiber=host.ctx.plugin({name:'remote-original-memory-test',inject:memory.inject,apply(child){memory.apply(child,{dir:base.localDir,enabled:true,injectContext:true,autoCapture:false,tideEnabled:false,dailyBackup:false,logRetrieval:false,injectTokenBudget:2000})}});await fiber.await()
  host.agent.followup({id:'synthetic-remote-memory-turn',role:'user',content:[{type:'text',text:'麦克风 合成远端写入工具验证'}],source:{kind:'plugin'}})
  for(let i=0;i<500;i++){if(host.agent.status==='idle'&&host.agent.session.snapshotEvents().some(e=>e.type==='turn/end'))break;await new Promise(r=>setTimeout(r,5))}
  await fenced.drain();assert.deepEqual(host.errors,[]);assert.equal(commits,1);assert.equal(executor.pending(),null)
  assert.equal(base.read("SELECT count(*) n FROM memories WHERE content='合成工具链已提交 风铃约定'")[0].n,1)
  assert.equal(base.gateway.head(base.lease).revision,1);assert.equal(host.requests.length,3)
 }finally{if(fiber){await fiber.dispose();if(fiber.inertia)await fiber.inertia}if(network)await network.cleanup();if(host)await host.cleanup();else base.cleanup()}
})
