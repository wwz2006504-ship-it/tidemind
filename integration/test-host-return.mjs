import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {aurabotHost} from './aurabot-host-fixture.mjs'
const digest=b=>createHash('sha256').update(b).digest('hex')
const heartbeat=()=>({legacyDetached:true,readConfig:()=>({enabled:true,intervalSeconds:30,pauseAfterMissed:3,compactBeforeBeat:false,awakeSeconds:0,prompt:'SYNTHETIC RETURN HEARTBEAT'})})

test('whole isolated host cold-rebuild retains memory, identity, dedup and single heartbeat without restoring old databases',async()=>{
 const first=await aurabotHost({heartbeat:heartbeat()});let second,closed=false
 try{
  const baseline=digest(readFileSync(first.cloud)),identity=first.replica.replicaHead(first.local).protected_hash
  const input=first.event(12001,'麦克风 我喜欢合成蓝色风铃')
  await first.emit(input);await first.settle()
  const rows=first.read('SELECT id,content,tags,status,valid_to,superseded_by,updated_at FROM memories ORDER BY id'),revision=first.gateway.head(first.lease).revision
  assert.ok(revision>0)
  await first.unmount();await first.supervisor.close();await first.closeRuntime();closed=true
  assert.equal(first.handle.heartbeat.runtime.disposed,true)
  second=await aurabotHost({heartbeat:heartbeat(),storageFixture:first.storageFixture,resumeSessionId:first.agent.id})
  assert.equal(second.agent.id,first.agent.id)
  assert.deepEqual(second.read('SELECT id,content,tags,status,valid_to,superseded_by,updated_at FROM memories ORDER BY id'),rows)
  assert.equal(second.gateway.head(second.lease).revision,revision)
  assert.equal(second.replica.replicaHead(second.local).protected_hash,identity)
  await second.emit(input);await new Promise(r=>setTimeout(r,20));assert.equal(second.sent.length,0);assert.equal(second.requests.length,0)
  await second.emit(second.event(12002,'蓝色风铃'));await second.settle()
  assert.equal(second.sent.length,1);assert.ok(JSON.stringify(second.requests[0].messages).includes('蓝色风铃'))
  assert.equal(digest(readFileSync(second.cloud)),baseline)
  await assert.rejects(first.handle.heartbeat.tick(),/stopped|disposed/)
  await second.supervisor.setRest(false,{op:'return-wake'});await second.handle.heartbeat.tick();assert.equal(second.sent.length,1)
 }finally{if(second)await second.cleanup();else if(closed)first.storageFixture.cleanup();else await first.cleanup()}
})
