import test from 'node:test'
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import {join} from 'node:path'
import {qqFixture} from './qq-fixture.mjs'
import {createQQOutbound} from './qq-outbound.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
const load=n=>import(pathToFileURL(base+'/'+n+'/lib/index.js').href)
test('installed DSH JSONL persistence proves admitted and consumed input; restart admission never calls followup twice',async()=>{
 const f=await qqFixture();let ctx,writer
 try{
  const [{Context},backend,{SESSION_FORMAT_VERSION}]=await Promise.all([load('cordis'),load('dsh-session-persistence-jsonl'),load('dsh-session')])
  ctx=new Context();await backend.apply(ctx,{root:join(f.root,'sessions'),compression:'none'})
  const persistence=ctx.sessionPersistence,sessionId='durable-synthetic-my-agent'
  writer=await persistence.create({version:SESSION_FORMAT_VERSION,id:sessionId,createdAt:Date.now(),isSeeded:false,delegationDepth:0,cwd:f.root})
  const reader=createSessionHistoryReader(persistence),{origin}=f.observe(f.event('920'))
  const outbound=createQQOutbound({...f,selfId:'10001',allowTargets:['private:20001'],transport:async()=>assert.fail('no QQ'),historyReader:reader})
  let calls=0,input
  const a={sessionId,chatId:'private:20001',origins:[origin],content:[{type:'text',text:'合成持久消息'}],followup:async m=>{calls++;input=m},flush:async()=>{
   await writer.append([{seq:0,time:Date.now(),type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[input]}}]);await writer.flush()
  }}
  assert.equal((await outbound.admitInput(a)).state,'accepted')
  const replay=await outbound.admitInput(a);assert.equal(replay.replayed,true);assert.equal(calls,1)
  await writer.append([{seq:1,time:Date.now(),type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{seq:2,time:Date.now(),type:'user/message',data:input,surfaceOp:'append'}]);await writer.flush()
  assert.equal((await reader({sessionId,id:input.id,contentHash:hash(input.content)})).stage,'consumed')
  assert.equal((await reader({sessionId,id:input.id,contentHash:hash([])})).state,'unknown')
  assert.equal((await reader({sessionId,id:'never-submitted',contentHash:hash([])})).state,'absent')
  await writer.close();writer=null
  await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia
  ctx=new Context();await backend.apply(ctx,{root:join(f.root,'sessions'),compression:'none'})
  const cold=createQQOutbound({...f,selfId:'10001',allowTargets:['private:20001'],transport:async()=>assert.fail('no QQ'),historyReader:createSessionHistoryReader(ctx.sessionPersistence)})
  assert.equal((await cold.admitInput(a)).stage,'consumed');assert.equal(calls,1)
  const review=await cold.reviewAdmissions();assert.equal(review[0].state,'accepted');assert.equal(review[0].automaticReplay,false)
 }finally{if(writer)await writer.close();if(ctx){await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia}await f.cleanup()}
})
test('truncated, inherited, changing and unavailable history cannot authorize automatic replay',async()=>{
 for(const mode of ['truncated','inherited','changing','missing']){
  let reads=0,closed=false
  const reader=createSessionHistoryReader({open:async()=>{if(mode==='missing')throw Error('missing');return {access:'read',header:{id:'s'},inheritedEventCount:mode==='inherited'?1:0,read:async()=>({events:mode==='truncated'?[{seq:1,type:'session/end-seed'}]:mode==='changing'&&reads++?[{seq:0,type:'session/end-seed'}]:[]}),close:async()=>{closed=true}}}})
  const result=await reader({sessionId:'s',id:'id',contentHash:hash([])});assert.equal(result.state,'unknown');assert.equal(result.automaticReplay,false);assert.equal(closed,mode!=='missing')
 }
})


test('original Hub is wired to real installed persistence reader in isolated fixture',async()=>{
 const f=await qqFixture({durableHistory:true});try{
  await f.hub.onMessage(f.event('931'));await f.waitAdmissions(1)
  for(let i=0;i<50&&f.outbound.recoveryStatus().admissions[0]?.state!=='accepted';i++)await new Promise(r=>setTimeout(r,5))
  assert.equal(f.outbound.recoveryStatus().admissions[0].state,'accepted')
  assert.equal((await f.outbound.reviewAdmissions())[0].state,'accepted')
  await f.hub.onMessage(f.event('931'));assert.equal(f.admissions.length,1)
 }finally{await f.cleanup()}
})
test('flush success without evidence stops; review never resubmits absent or unknown input',async()=>{
 const f=await qqFixture();try{
  for(const evidence of ['absent','unknown']){
   const outbound=createQQOutbound({...f,selfId:'10001',allowTargets:['private:20001'],transport:async()=>assert.fail('no QQ'),historyReader:async()=>({state:evidence})})
   const {origin}=f.observe(f.event(evidence==='absent'?'941':'942'));let calls=0
   const a={sessionId:f.agent.id,chatId:'private:20001',origins:[origin],content:[],followup:async()=>calls++,flush:async()=>{}}
   await assert.rejects(outbound.admitInput(a),evidence==='absent'?/interrupted/:/confirmed absence/)
   await assert.rejects(outbound.admitInput(a),evidence==='absent'?/automatic replay denied/:/confirmed absence/)
   assert.ok((await outbound.reviewAdmissions()).every(r=>r.state==='needs_review'&&!r.automaticReplay));assert.equal(calls,evidence==='absent'?1:0)
  }
 }finally{await f.cleanup()}
})
