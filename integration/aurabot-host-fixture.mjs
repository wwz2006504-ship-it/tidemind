// Mount the original host control flow in real Cordis. All external edges are offline doubles.
import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {controllerHost} from './controller-host.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
import * as fenced from './fenced-store.mjs'
import {mountExistingHost} from './mount-existing-host.mjs'
import groupAdmin from '../host/aurabot/src/modules/group-admin/index.js'
import qqTools from '../host/aurabot/src/modules/qq-tools/index.js'
import {createTaskCheckpoints} from './task-checkpoints.mjs'

export async function aurabotHost({mode='reply',builtins=[groupAdmin,qqTools],snowRunning,heartbeat,activityUnits=1,prepareModules,configPatch={},storageFixture,resumeSessionId,cosyvoiceSynth,dependencyOverrides={},protectedMemory,prepareBindings}={}){
 const f=await controllerHost({mode,reasoning:true,storageFixture,resumeSessionId}),sent=[],calls=[],activityCallbacks=[],routes=new Map(),lifecycle={start:0,stop:0,snowDispose:0,refresh:0,seed:0}
 let handle,fiber,options,supervisor,closed=false,state='stopped'
 try{
 const paths={TIDEMIND_AURABOT_DATA_ROOT:join(f.root,'aurabot-data'),TIDEMIND_AURABOT_HOME:join(f.root,'aurabot-home'),TIDEMIND_AURABOT_WORKSPACE:join(f.root,'workspace'),TIDEMIND_SELF_NOTES_DIR:join(f.root,'self-notes')}
 for(const [key,p]of Object.entries(paths)){mkdirSync(p,{recursive:true});process.env[key]=p}
 process.env.TIDEMIND_AURABOT_MEMORY_DB=f.local
 const prepared=await prepareModules?.({f,paths})||{}
 for(const item of prepared.modules||[]){const directory=join(paths.TIDEMIND_AURABOT_DATA_ROOT,'modules',item.id);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'index.mjs'),item.source);item.setDirectory?.(directory)}
 const chats={chats:Object.fromEntries(['private:20001','group:30001'].map(id=>[id,{sessionId:f.agent.id,preset:'aurabot-private',level:'full',fresh:false}]))}
 writeFileSync(join(paths.TIDEMIND_AURABOT_DATA_ROOT,'sessions.json'),JSON.stringify(chats))
 const {saveConfig}=await import('../host/aurabot/src/core/config.js')
 saveConfig({enabled:true,dryRun:false,safeMode:!(prepared.modules?.length),botQQ:'10001',ownerQQ:'20001',ownerName:'SYNTHETIC',ownerLevel:'full',allow:{private:['20001'],groups:['30001']},snowluma:{autoStart:!!snowRunning,autoAttach:false},model:{},memory:{dailyNewSession:false},voice:{enabled:false,autoChance:0},stickers:{enabled:false,collect:false,autoChance:0},merge:{enabled:false},group:{overrides:{}},persona:{current:'synthetic'},...configPatch})
 const base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
 const {TimerService}=await import(pathToFileURL(base+'/cordis-plugin-timer/lib/index.js').href)
 new TimerService(f.ctx)
 f.ctx.provide('webServer',{register(route){if(routes.has(route.path))throw Error('duplicate route');routes.set(route.path,route);return ()=>routes.delete(route.path)}})
 const denied=()=>{throw Error('offline peripheral unavailable')}
 const dependencies={
  createOneBotClient(opts){options=opts;return {get state(){return state},start(){lifecycle.start++;state='connected';opts.onState(state)},stop(){lifecycle.stop++;state='stopped';opts.onState(state)},restart(){this.stop();this.start()},async call(action,params,transportOptions){calls.push({action,params,options:transportOptions});if(action.startsWith('send_')){sent.push({action,params});return {message_id:90000+sent.length}}return action==='get_group_member_info'?{role:'owner'}:action==='get_login_info'?{user_id:10001,nickname:'SYNTHETIC'}:{}}}},
  createSnowLumaManager:()=>({detect:()=>({installed:!!snowRunning}),running:snowRunning|| (async()=>false),start:async()=>{throw Error('unexpected process launch')},dispose(){lifecycle.snowDispose++},endpoint:()=>({}),lastAttach:{at:0},webuiUrl:()=>'',ownsProcess:false}),DOWNLOAD_PAGE:'offline',
  createLocal:()=>({dir:()=>join(f.root,'local-tools'),status:()=>[],active:()=>false,call:denied}),fileOf:denied,toImageBuffer:denied,openFolder:denied,
  createUpdateChecker:()=>denied,changelogSection:()=>'',parseCommand:()=>null,runCommand:denied,createMutes:()=>({muted:()=>false}),commandList:()=>[],
  listPersonas:()=>[{id:'synthetic',name:'SYNTHETIC'}],readPersona:id=>id==='synthetic'?{id,text:'SYNTHETIC PERSONA'}:null,savePersona:denied,deletePersona:denied,currentPersonaText:()=> 'SYNTHETIC PERSONA',rulesText:()=> 'SYNTHETIC RULES',seedPersonas(){lifecycle.seed++},
  createBridge:()=>({refresh(){lifecycle.refresh++},deniedTools:()=>[],authorized:()=>false}),BUILTINS:builtins,
 }
 Object.assign(dependencies,dependencyOverrides)
 supervisor=createTaskCheckpoints({...f,budget:20,handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>p]))})
 const patch=await prepareBindings?.({f,supervisor,paths,dependencies})||{}
 const bindings={isolated:true,dependencies,cosyvoiceSynth,protectedMemory,moduleLib:prepared.moduleLib,moduleImporter:prepared.importModule,taskSupervisor:supervisor,activityAgent:f.agent,moduleActivityUnits:activityUnits,heartbeat,onActivityRegistration:r=>activityCallbacks.push(r),authority:{lease:f.lease,gateway:f.gateway,term:f.term,holder:'local'},allowTargets:['private:20001','group:30001'],historyReader:createSessionHistoryReader(f.ctx.sessionPersistence),...patch}
 const mounted=await mountExistingHost(f.ctx,{bindings});fiber=mounted.fiber;handle=mounted.handle
 const event=(id=1001,text='麦克风 我喜欢合成蓝色风铃')=>({post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:id,message:[{type:'text',data:{text}}],sender:{nickname:'SYNTHETIC'}})
 const emit=ev=>options.onEvent(ev)
 const settle=async(expectedSent=1)=>{for(let i=0;i<300;i++){if(f.agent.status==='idle'&&sent.length>=expectedSent&&f.agent.session.snapshotEvents().some(e=>e.type==='turn/end')){await fenced.drain();await f.ctx.sessions.flush(f.agent.session);return}await new Promise(r=>setTimeout(r,5))}throw Error('host did not settle: '+f.errors.map(e=>e.message).join(','))}
 const unmount=async()=>{if(closed)return;await mounted.dispose();closed=true}
 const request=async(path,body)=>{const entry=routes.get('/aurabot/api'+path)||routes.get('/aurabot/api');if(!entry)throw Error('route unmounted');let result;const req={url:'/aurabot/api'+path,async *[Symbol.asyncIterator](){if(body!==undefined)yield Buffer.from(JSON.stringify(body))}};await entry.handler(req,{setHeader(){},end(value){result=JSON.parse(value)}});return result}
 return {...f,handle,mounted,bindings,supervisor,sent,calls,activityCallbacks,routes,lifecycle,event,emit,settle,unmount,request,cleanup:async()=>{await unmount();await supervisor.close();await f.cleanup()}}
 }catch(error){if(fiber){await fiber.dispose();if(fiber.inertia)await fiber.inertia}if(supervisor)await supervisor.close();await f.cleanup();throw error}
}
