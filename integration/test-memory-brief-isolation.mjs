import test from 'node:test'
import assert from 'node:assert/strict'
import {qqFixture} from './qq-fixture.mjs'
import {memoryBrief} from '../host/aurabot/src/features/memories.js'
test('opening brief only reads explicitly bound synthetic DB; missing/production/outside path yields empty even after cache warmup',async()=>{
 const f=await qqFixture();const previous=process.env.TIDEMIND_AURABOT_MEMORY_DB
 try{
  process.env.TIDEMIND_AURABOT_MEMORY_DB=f.local;assert.match(await memoryBrief(f.agent),/SYNTHETIC IMMUTABLE CORE/)
  assert.equal(await memoryBrief({id:'other',session:{id:'other'}}),'');assert.equal(await memoryBrief(),'')
  for(const path of [undefined,'<MEMORY_LAYERS_DIR>/memory.db','C:/Users/USERNAME/Aurabot/qq-chats/tidemind-shadow/memory-shadow.db']){
   if(path===undefined)delete process.env.TIDEMIND_AURABOT_MEMORY_DB;else process.env.TIDEMIND_AURABOT_MEMORY_DB=path
   assert.equal(await memoryBrief(f.agent),'')
  }
 }finally{if(previous===undefined)delete process.env.TIDEMIND_AURABOT_MEMORY_DB;else process.env.TIDEMIND_AURABOT_MEMORY_DB=previous;await f.cleanup()}
})
