import {test} from 'node:test'
import assert from 'node:assert/strict'
import {join} from 'node:path'
import {existsSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {fixture} from './fixture.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {captureSessionHistory,assertSessionHistoryExtension,materializeSessionHistoryCandidate} from './session-history-transfer.mjs'
const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
const load=n=>import(pathToFileURL(base+'/'+n+'/lib/index.js').href)
async function openPersistence(root){
 const [{Context},backend]=await Promise.all([load('cordis'),load('dsh-session-persistence-jsonl')])
 const ctx=new Context();await backend.apply(ctx,{root,compression:'none'})
 return {persistence:ctx.sessionPersistence,async close(){await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia}}
}
async function setup(){
 const f=await fixture(),source=await openPersistence(join(f.root,'history-source'))
 const writer=await source.persistence.create({version:4,id:'synthetic-history-my-agent',createdAt:1,isSeeded:false,delegationDepth:0,cwd:join(f.root,'workspace')})
 const append=async text=>{const events=(await writer.read(0)).events;await writer.append([{seq:events.length,time:events.length+1,type:'user/message',data:{id:'message-'+events.length,role:'user',content:[{type:'text',text}],source:{kind:'aurabot',origin:'qq-user'}},surfaceOp:'append'}]);await writer.flush()}
 return {...f,source,writer,append,async close(){try{await writer.close();await source.close()}finally{f.cleanup()}}}
}
test('original SDK history copies into immutable candidate, resumes without duplicate events, preserves source',async()=>{
 const f=await setup();try{
  await f.append('SYNTHETIC FIRST');const before=await captureSessionHistory(f.source.persistence,f.writer.id)
  await f.append('SYNTHETIC SECOND');const next=await captureSessionHistory(f.source.persistence,f.writer.id),root=join(f.root,'history-candidates')
  const args={root,source:next,expectedDigest:next.digest,base:before,openPersistence}
  assert.equal((await materializeSessionHistoryCandidate({...args,dryRun:true})).appended,1);assert.equal(existsSync(root),false)
  const result=await materializeSessionHistoryCandidate(args);assert.equal(result.verified,true);assert.equal(result.selected,false)
  const repeated=await materializeSessionHistoryCandidate(args);assert.equal(repeated.digest,result.digest);assert.equal(repeated.directory,result.directory)
  assert.equal((await captureSessionHistory(f.source.persistence,f.writer.id)).digest,next.digest)
  const target=await openPersistence(result.directory);try{assert.deepEqual((await captureSessionHistory(target.persistence,f.writer.id)).events,next.events)}finally{await target.close()}
 }finally{await f.close()}
})
test('newer destination, changed history, wrong identity and wrong trusted digest stop before candidate creation',async()=>{
 const f=await setup();try{
  await f.append('SYNTHETIC FIRST');const before=await captureSessionHistory(f.source.persistence,f.writer.id)
  await f.append('SYNTHETIC SECOND');const next=await captureSessionHistory(f.source.persistence,f.writer.id),root=join(f.root,'must-not-create')
  assert.throws(()=>assertSessionHistoryExtension(next,before),/newer destination/)
  const changed=structuredClone(next);changed.events[0].data.content[0].text='BRANCH'
  await assert.rejects(materializeSessionHistoryCandidate({root,source:changed,expectedDigest:next.digest,base:before,openPersistence}),/digest differs/)
  await assert.rejects(materializeSessionHistoryCandidate({root,source:next,expectedDigest:before.digest,base:before,openPersistence}),/trusted source/)
  const {digest:discard,...body}=changed;changed.digest=hash(body)
  assert.throws(()=>assertSessionHistoryExtension(before,changed),/branch/)
  const foreign=structuredClone(next);foreign.header.id='another-session';const {digest:unused,...foreignBody}=foreign;foreign.digest=hash(foreignBody)
  assert.throws(()=>assertSessionHistoryExtension(before,foreign),/identity\/header differs/)
  assert.equal(existsSync(root),false)
 }finally{await f.close()}
})

test('lost SDK append acknowledgement leaves candidate resumable without altering source or duplicating history',async()=>{
 const f=await setup();try{
  await f.append('SYNTHETIC LOST ACK');const source=await captureSessionHistory(f.source.persistence,f.writer.id),root=join(f.root,'lost-ack-candidates')
  let lost=false
  const faulty=async directory=>{const b=await openPersistence(directory),original=b.persistence.create.bind(b.persistence)
   b.persistence.create=async header=>{const handle=await original(header),append=handle.append.bind(handle);handle.append=async events=>{await append(events);lost=true;throw Error('SYNTHETIC APPEND ACK LOST')};return handle};return b}
  await assert.rejects(materializeSessionHistoryCandidate({root,source,expectedDigest:source.digest,openPersistence:faulty}),/APPEND ACK LOST/)
  assert.equal(lost,true)
  const result=await materializeSessionHistoryCandidate({root,source,expectedDigest:source.digest,openPersistence})
  assert.equal(result.verified,true);assert.equal((await captureSessionHistory(f.source.persistence,f.writer.id)).digest,source.digest)
 }finally{await f.close()}
})
test('unstable source read refuses snapshot and always closes read handle',async()=>{
 let reads=0,closed=false
 await assert.rejects(captureSessionHistory({open:async()=>({access:'read',header:{id:'synthetic'},inheritedEventCount:0,read:async()=>({events:reads++?[]:[{seq:0,type:'session/created'}]}),close:async()=>{closed=true}})},'synthetic'),/changed while capturing/)
 assert.equal(closed,true)
})
