// Test subprocess only. Never connects to QQ. --dry-run has no side effects.
if(process.argv.includes('--dry-run')){console.log('{"dryRun":true,"testOnly":true}');process.exit(0)}
import {appendFileSync,readFileSync,realpathSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {join,relative,isAbsolute} from 'node:path'
import {qqFixture} from './qq-fixture.mjs'
import {dataRoot} from './fixture.mjs'
const mode=process.env.TIDEMIND_QQ_TEST_MODE
if(mode==='crash-admission'){
 const f=await qqFixture()
 const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
 const backend=await import(pathToFileURL(base+'/dsh-session-persistence-jsonl/lib/index.js').href)
 const {SESSION_FORMAT_VERSION}=await import(pathToFileURL(base+'/dsh-session/lib/index.js').href)
 await backend.apply(f.ctx,{root:join(f.root,'sessions'),compression:'none'})
 const writer=await f.ctx.sessionPersistence.create({version:SESSION_FORMAT_VERSION,id:f.agent.id,createdAt:Date.now(),isSeeded:false,delegationDepth:0,cwd:f.root})
 const {origin}=f.observe(f.event('981'));let input
 await f.outbound.admitInput({sessionId:f.agent.id,chatId:'private:20001',origins:[origin],content:[{type:'text',text:'synthetic durable crash'}],followup:async m=>{input=m;appendFileSync(join(f.root,'admission-attempts.txt'),'one\n')},flush:async()=>{
  await writer.append([{seq:0,time:Date.now(),type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[input]}}]);await writer.flush()
  console.log(JSON.stringify({phase:'durable-before-authority-ack',root:f.root}));setInterval(()=>{},1000);await new Promise(()=>{})
 }})
}else if(mode==='recover-admission'){
 const root=realpathSync(process.env.TIDEMIND_QQ_TEST_ROOT),rel=relative(realpathSync(dataRoot),root)
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('test root outside data directory')
 process.env.TIDEMIND_SANDBOX_ROOT=root;process.env.TIDEMIND_LEASE_DB=join(root,'lease.db')
 const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
 const {Context}=await import(pathToFileURL(base+'/cordis/lib/index.js').href),backend=await import(pathToFileURL(base+'/dsh-session-persistence-jsonl/lib/index.js').href)
 const ctx=new Context();await backend.apply(ctx,{root:join(root,'sessions'),compression:'none'})
 const lease=await import('../TideMind/deploy/existing/lease.mjs'),gateway=await import('../TideMind/deploy/existing/tide-gateway.mjs')
 const {createQQOutbound}=await import('./qq-outbound.mjs'),{createSessionHistoryReader}=await import('./session-history.mjs')
 const outbound=createQQOutbound({lease,gateway,holder:'local',term:lease.status().term,selfId:'10001',allowTargets:['private:20001'],transport:async()=>{throw Error('no QQ')},historyReader:createSessionHistoryReader(ctx.sessionPersistence)})
 const rows=await outbound.reviewAdmissions()
 console.log(JSON.stringify({states:rows.map(r=>r.state),stages:rows.map(r=>r.stage),attempts:readFileSync(join(root,'admission-attempts.txt'),'utf8').trim().split('\n').length}))
 await ctx.fiber.dispose();if(ctx.fiber.inertia)await ctx.fiber.inertia
}else if(mode==='crash-window'){
 let f
 f=await qqFixture({transport:async()=>{
  appendFileSync(join(f.root,'wire-attempts.txt'),'synthetic-send\n')
  console.log(JSON.stringify({phase:'sent-before-ACK',root:f.root}))
  setInterval(()=>{},1000)
  return await new Promise(()=>{})
 }})
 await f.reply(f.bind([f.event('801')]),'合成发送后中断')
}else if(process.env.TIDEMIND_QQ_TEST_MODE==='recover'){
 const root=realpathSync(process.env.TIDEMIND_QQ_TEST_ROOT),rel=relative(realpathSync(dataRoot),root)
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('test root outside data directory')
 process.env.TIDEMIND_SANDBOX_ROOT=root;process.env.TIDEMIND_LEASE_DB=join(root,'lease.db')
 const lease=await import('../TideMind/deploy/existing/lease.mjs'),gateway=await import('../TideMind/deploy/existing/tide-gateway.mjs')
 const {createQQOutbound}=await import('./qq-outbound.mjs')
 const state=lease.status()
 const outbound=createQQOutbound({lease,gateway,holder:'local',term:state.term,selfId:'10001',allowTargets:['private:20001'],transport:async()=>{appendFileSync(join(root,'wire-attempts.txt'),'DUPLICATE\n');return {message_id:999}}})
 const db=lease.openAuthority();let payload
 try{payload=JSON.parse(db.prepare('SELECT payload FROM tide_outbox').get().payload)}finally{db.close()}
 const captured={result:payload.requests.map(()=>({kind:'text',value:'合成发送后中断'})),sent:payload.requests.map(r=>({chatId:'private:20001',message:r.params.message}))}
 const replay=await outbound.reply({sessionId:'session-synthetic-my-agent',turn:1,chatId:'private:20001'},async()=>captured)
 const audit=outbound.audit()
 console.log(JSON.stringify({state:replay.state,wireAttempts:readFileSync(join(root,'wire-attempts.txt'),'utf8').trim().split('\n').length,parts:audit.parts.map(r=>r.state)}))
}else throw new Error('explicit test-only subprocess mode required')
