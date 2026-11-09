// Original Hub source, isolated data roots, actual parser, no real OneBot client.
import {mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createSessionHistoryReader} from './session-history.mjs'
import {host} from './isolated-host.mjs'
import {createQQOutbound} from './qq-outbound.mjs'
export async function qqFixture({transport,hooks={},merge=false,durableHistory=false}={}){
 const h=await host(),sent=[],admissions=[],logs=[]
 const paths={TIDEMIND_AURABOT_DATA_ROOT:join(h.root,'aurabot-data'),TIDEMIND_AURABOT_HOME:join(h.root,'aurabot-home'),TIDEMIND_AURABOT_WORKSPACE:join(h.root,'qq-workspace'),TIDEMIND_SELF_NOTES_DIR:join(h.root,'self-notes')}
 for(const [key,path]of Object.entries(paths)){mkdirSync(path);process.env[key]=path}
 process.env.TIDEMIND_AURABOT_MEMORY_DB=h.local
 const {createHub}=await import('../host/aurabot/src/chat/hub.js')
 const {parseMessageEvent}=await import('../host/aurabot/src/chat/inbound.js')
 let writer,historyReader,flush=async()=>{},sequence=0
 if(durableHistory){
  const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
  const backend=await import(pathToFileURL(base+'/dsh-session-persistence-jsonl/lib/index.js').href)
  const {SESSION_FORMAT_VERSION}=await import(pathToFileURL(base+'/dsh-session/lib/index.js').href)
  await backend.apply(h.ctx,{root:join(h.root,'sessions'),compression:'none'})
  writer=await h.ctx.sessionPersistence.create({version:SESSION_FORMAT_VERSION,id:h.agent.id,createdAt:Date.now(),isSeeded:false,delegationDepth:0,cwd:h.root})
  historyReader=createSessionHistoryReader(h.ctx.sessionPersistence)
  flush=async()=>{await writer.flush()}
 }
 const outbound=createQQOutbound({...h,historyReader,holder:'local',selfId:'10001',allowTargets:['private:20001','private:20002','group:30001'],transport:transport||(async(action,params)=>{sent.push({action,params});return {message_id:70000+sent.length}})})
 const cfg={enabled:true,dryRun:false,botQQ:'10001',ownerQQ:'20001',ownerName:'SYNTHETIC',ownerLevel:'chat',
  allow:{private:['20001','20002'],groups:['30001']},model:{},memory:{dailyNewSession:false},
  voice:{enabled:false,autoChance:0},stickers:{enabled:false,collect:false,autoChance:0},
  merge:{enabled:merge,waitSec:.005,maxSec:.01,groupWaitSec:.005,groupMaxSec:.01},group:{overrides:{}}}
 const workspaces=[]
 const controller={create:async()=>({sessionId:h.agent.id}),rename:async()=>{},resolveAgent:async()=>({agent:h.agent})}
 h.agent.followup=async message=>{admissions.push(message);if(writer)await writer.append([{seq:sequence++,time:Date.now(),type:'agent/inbox/spliced',data:{target:'next-turn',start:admissions.length-1,removedCount:0,inserted:[message]}}])}
 const dsh={get:name=>name==='sessionController'?controller:undefined,agents:new Map([[h.agent.id,h.agent]]),
  workspaceRegistry:{list:()=>workspaces,create:async path=>{const value={id:'synthetic-workspace',path};workspaces.push(value);return value}},sessions:{flush}}
 const hub=createHub({dsh,getConfig:()=>cfg,log:Object.fromEntries(['info','warn','error','debug'].map(k=>[k,(...a)=>logs.push(k)])),
  onebot:outbound.guardedClient,stickers:{},tts:{speak:async()=>{throw new Error('TTS disabled')}},hooks,outbound})
 const event=(messageId='101',userId='20001',text='合成入站消息')=>({post_type:'message',message_type:'private',self_id:10001,user_id:Number(userId),message_id:Number(messageId),message:[{type:'text',data:{text}}],sender:{nickname:'SYNTHETIC'}})
 const observe=e=>outbound.observeInbound(e,parseMessageEvent(e,'10001'))
 const bind=(events,turn=1,chatId='private:20001')=>{const origins=events.map(e=>observe(e).origin);outbound.bindTurn({sessionId:h.agent.id,turn,chatId,origins});return {sessionId:h.agent.id,turn,chatId}}
 const render=(chatId,text)=>()=>hub.capture(()=>hub.deliver(chatId,text,{simulate:true}))
 const reply=(binding,text)=>outbound.reply(binding,render(binding.chatId,text))
 const waitAdmissions=async n=>{for(let i=0;i<100;i++){if(admissions.length>=n)return;await new Promise(r=>setTimeout(r,5))}throw new Error('Hub admission did not complete')}
 const finish=async text=>{
  hub.onSessionEvent(h.agent.session,{type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text}]}}})
  hub.onSessionEvent(h.agent.session,{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}})
  await outbound.idle()
 }
 const cleanup=async()=>{await outbound.idle();hub.dispose();if(writer)await writer.close();await h.cleanup()}
 return {...h,hub,outbound,cfg,event,bind,observe,reply,render,finish,waitAdmissions,sent,admissions,logs,cleanup}
}
