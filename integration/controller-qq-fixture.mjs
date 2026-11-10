// Original Hub bound to a REAL controller-created agent; QQ/model external I/O stays synthetic.
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {controllerHost} from './controller-host.mjs'
import {createQQOutbound} from './qq-outbound.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
import * as fenced from './fenced-store.mjs'
export async function controllerQQ(options){
 const f=await controllerHost(options),sent=[],logs=[]
 const paths={TIDEMIND_AURABOT_DATA_ROOT:join(f.root,'aurabot-data'),TIDEMIND_AURABOT_HOME:join(f.root,'aurabot-home'),TIDEMIND_AURABOT_WORKSPACE:join(f.root,'workspace'),TIDEMIND_SELF_NOTES_DIR:join(f.root,'self-notes')}
 for(const [key,path]of Object.entries(paths)){mkdirSync(path,{recursive:true});process.env[key]=path}
 // Explicit pre-bound my-agent identity, never bind arbitrary controller sessions to these memories.
 writeFileSync(join(paths.TIDEMIND_AURABOT_DATA_ROOT,'sessions.json'),JSON.stringify({chats:{'private:20001':{sessionId:f.agent.id,preset:'aurabot-private',level:'full',fresh:false}}}))
 const cfg={enabled:true,dryRun:false,botQQ:'10001',ownerQQ:'20001',ownerName:'SYNTHETIC',ownerLevel:'full',allow:{private:['20001'],groups:[]},model:{},memory:{dailyNewSession:false},voice:{enabled:false,autoChance:0},stickers:{enabled:false,collect:false,autoChance:0},merge:{enabled:false},group:{overrides:{}}}
 const outbound=createQQOutbound({...f,selfId:'10001',allowTargets:['private:20001'],historyReader:createSessionHistoryReader(f.ctx.sessionPersistence),transport:async(action,params)=>{sent.push({action,params});return {message_id:90000+sent.length}}})
 process.env.TIDEMIND_AURABOT_MEMORY_DB=f.local
 const {createHub}=await import('../host/aurabot/src/chat/hub.js')
 const hub=createHub({dsh:f.ctx,getConfig:()=>cfg,log:Object.fromEntries(['info','warn','error','debug'].map(k=>[k,(...args)=>logs.push({level:k,args})])),onebot:outbound.guardedClient,stickers:{},tts:{speak:async()=>{throw Error('TTS disabled')}},outbound})
 const off=f.ctx.on('session/event',(session,event)=>hub.onSessionEvent(session,event))
 const event=(id=1001,text='麦克风 我喜欢合成蓝色风铃')=>({post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:id,message:[{type:'text',data:{text}}],sender:{nickname:'SYNTHETIC'}})
 const settle=async()=>{
  for(let i=0;i<300;i++){
   const current=f.ctx.agents.get(f.agent.id),state=outbound.recoveryStatus()
   if(current?.status==='idle'&&state.queued.length===0&&current.session.snapshotEvents().some(e=>e.type==='turn/end')){
    await fenced.drain();await outbound.idle();await f.ctx.sessions.flush(current.session)
    const reviewed=await outbound.reviewAdmissions()
    if(reviewed.every(r=>r.state==='accepted'))return
   }
   await new Promise(r=>setTimeout(r,5))
  }
  throw Error('real loop did not settle: '+f.errors.map(e=>e.message).join(','))
 }

 const shutdown=async()=>{off();await outbound.idle();hub.dispose();await f.closeRuntime()}
 const cleanup=async()=>{await shutdown();f.storageFixture.cleanup()}
 return {...f,cfg,hub,outbound,sent,logs,event,settle,cleanup,shutdown}
}

