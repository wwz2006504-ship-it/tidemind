import test from 'node:test'
import assert from 'node:assert/strict'
import {join,dirname,basename} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {realpathSync,rmSync} from 'node:fs'
import {dataRoot} from './fixture.mjs'
import {controllerHost} from './controller-host.mjs'
import {freezeStoppedSessionHistory} from './session-history-freeze.mjs'
import {openNativeSessionStorage} from './native-session-storage.mjs'
import {captureSessionHistoryBundle} from './session-history-bundle.mjs'
const mappings=f=>({'private:20001':{sessionId:f.agent.id,preset:'aurabot-private',level:'full'}})

test('independent original SDK host must exit before the controller can hold its history writer',async()=>{
 const module=JSON.stringify(new URL('./controller-host.mjs',import.meta.url).href)
 const script=`import {controllerHost} from ${module};const f=await controllerHost();await f.ctx.sessions.flush(f.agent.session);process.once('message',async message=>{if(message!=='stop')throw Error('invalid stop request');await f.closeRuntime();process.disconnect()});process.send({root:f.root,id:f.agent.id})`
 const child=spawn(process.execPath,['--input-type=module','-e',script],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']})
 const exited=once(child,'exit');exited.catch(()=>{})
 let root,backend,writer,diagnostic=''
 const previousRoot=process.env.TIDEMIND_SANDBOX_ROOT
 child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-2000)})
 const deadline=setTimeout(()=>child.kill(),15000)
 try{
  const ready=once(child,'message').then(([message])=>message)
  const {root:reported,id}=await Promise.race([ready,exited.then(()=>{throw Error('isolated host exited before ready: '+diagnostic)})])
  const verified=realpathSync(reported)
  assert.equal(dirname(verified),realpathSync(dataRoot));assert.match(basename(verified),/^verified-[\w-]+$/);root=verified
  process.env.TIDEMIND_SANDBOX_ROOT=root
  backend=await openNativeSessionStorage(join(root,'sessions'))
  const mapping=mappings({agent:{id}})
  const before=await captureSessionHistoryBundle({persistence:backend.persistence,mappings:mapping})
  await assert.rejects(backend.persistence.open(id,'write'),error=>error.name==='SessionAlreadyOwnedError')
  child.send('stop')
  assert.deepEqual(await exited,[0,null],diagnostic)
  writer=await backend.persistence.open(id,'write')
  const frozen=await captureSessionHistoryBundle({persistence:backend.persistence,mappings:mapping,previous:before})
  assert.equal(frozen.digest,before.digest)
 }finally{
  clearTimeout(deadline)
  if(child.exitCode===null&&child.signalCode===null)child.kill()
  await exited.catch(()=>{})
  await writer?.close();await backend?.close()
  if(previousRoot===undefined)delete process.env.TIDEMIND_SANDBOX_ROOT;else process.env.TIDEMIND_SANDBOX_ROOT=previousRoot
  if(root)rmSync(root,{recursive:true,force:true})
 }
})

test('history dry-run never stops original runtime and fake stop cannot produce freeze proof',async()=>{
 const f=await controllerHost();try{
  let stopped=false;const args={ctx:f.ctx,mappings:mappings(f),historyRoot:join(f.root,'sessions'),stopRuntime:async()=>{stopped=true}}
  const preview=await freezeStoppedSessionHistory({...args,dryRun:true});assert.equal(preview.stopped,false);assert.equal(stopped,false)
  await assert.rejects(freezeStoppedSessionHistory(args),/still owns session/);assert.equal(f.ctx.agents.get(f.agent.id),f.agent)
 }finally{await f.cleanup()}
})

test('actual original SDK stop and exclusive history writer prevent reopening until release without rewriting events',async()=>{
 const f=await controllerHost();let frozen,other
 try{
  await f.ctx.sessions.flush(f.agent.session)
  const original=await captureSessionHistoryBundle({persistence:f.ctx.sessionPersistence,mappings:mappings(f)})
  frozen=await freezeStoppedSessionHistory({ctx:f.ctx,mappings:mappings(f),historyRoot:join(f.root,'sessions'),stopRuntime:f.closeRuntime})
  assert.equal(frozen.authorizesHandover,false);assert.equal(frozen.bundle.digest,original.digest)
  other=await openNativeSessionStorage(join(f.root,'sessions'))
  await assert.rejects(other.persistence.open(f.agent.id,'write'),error=>error.name==='SessionAlreadyOwnedError')
  const script=`import {openNativeSessionStorage} from ${JSON.stringify(new URL('./native-session-storage.mjs',import.meta.url).href)};const b=await openNativeSessionStorage(process.argv[1]);try{const w=await b.persistence.open(process.argv[2],'write');await w.close();throw Error('second process obtained writer')}catch(error){if(error.name!=='SessionAlreadyOwnedError')throw error;process.stdout.write('writer-refused')}finally{await b.close()}`
  const probe=spawnSync(process.execPath,['--input-type=module','-e',script,join(f.root,'sessions'),f.agent.id],{windowsHide:true,encoding:'utf8',timeout:15000})
  assert.equal(probe.status,0,probe.stderr||probe.error?.message);assert.equal(probe.stdout,'writer-refused')
  assert.equal((await frozen.snapshot()).digest,original.digest)
  const release=frozen.release();assert.equal(frozen.release(),release);await release
  await assert.rejects(frozen.snapshot(),/already released/)
  const writer=await other.persistence.open(f.agent.id,'write');await writer.close()
  assert.equal((await captureSessionHistoryBundle({persistence:other.persistence,mappings:mappings(f)})).digest,original.digest)
 }finally{await frozen?.release();await other?.close();await f.cleanup()}
})
