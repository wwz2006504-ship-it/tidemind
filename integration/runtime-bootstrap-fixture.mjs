import {mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {controllerHost} from './controller-host.mjs'
import {normalize} from '../host/aurabot/src/core/config.js'
import {startExistingRuntime} from './start-existing-runtime.mjs'
const digest=b=>createHash('sha256').update(b).digest('hex')
export async function runtimeBootstrapFixture(){
 const f=await controllerHost({mountMemory:false,reasoning:true}),base=process.env.TIDEMIND_APP_MODULES||'<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai'
 let runtime,options;const routes=new Map(),sent=[],lifecycle={stop:0,dispose:0}
 try{
  const {Loader}=await import(pathToFileURL(base+'/cordis-plugin-loader/lib/index.js').href),{AgentPresetRegistry}=await import(pathToFileURL(base+'/dsh-agent-preset-registry/lib/index.js').href),{TimerService}=await import(pathToFileURL(base+'/cordis-plugin-timer/lib/index.js').href)
  const loader=new Loader(f.ctx);await loader.root.update([{id:'dsh-memory-layers',name:'dsh-memory-layers',disabled:true},{id:'dsh-heartbeat',name:'dsh-plugin-heartbeat',disabled:true}]);await loader.await()
  const presets=new AgentPresetRegistry(f.ctx,{default:'aurabot-private',selectedDefault:{get:()=>undefined}})
  for(const kind of ['private','social'])await presets.register({id:'aurabot-'+kind,name:'SYNTHETIC '+kind,plugins:[{id:'persona',name:pathToFileURL(base+'/dsh-persona/lib/index.js').href,config:{prefix:'{{aurabot_persona}}\n\n{{aurabot_rules_'+kind+'}}',complete:true}}]})
  await presets.mount(f.agent.ctx,'aurabot-private')
  new TimerService(f.ctx);f.ctx.provide('webServer',{register(route){if(routes.has(route.path))throw Error('duplicate route');routes.set(route.path,route);return ()=>routes.delete(route.path)}})
  const paths={root:f.root,sourceDataRoot:join(f.root,'original-aurabot'),dataRoot:join(f.root,'profile-data'),localDir:f.localDir,home:join(f.root,'profile-home'),workspace:join(f.root,'profile-workspace'),notes:join(f.root,'profile-notes')}
  for(const value of Object.values(paths))mkdirSync(value,{recursive:true});mkdirSync(join(paths.sourceDataRoot,'personas'))
  const cfg=normalize({enabled:true,dryRun:false,botQQ:'10001',ownerQQ:'20001',ownerLevel:'full',persona:{current:'synthetic'},snowluma:{autoStart:false,autoAttach:false},memory:{enabled:true,dailyNewSession:false},voice:{enabled:false},stickers:{enabled:false,collect:false},merge:{enabled:false},allow:{private:['20001'],groups:['30001']}})
  const config=Buffer.from(JSON.stringify(cfg)),persona=Buffer.from('---\nname: SYNTHETIC\ntags: []\n---\nSYNTHETIC BOOTSTRAP IDENTITY\n'),jsonMemory=Buffer.from(JSON.stringify({items:[{id:'baseline-json',text:'合成原始麦克风记忆',at:Date.now(),importance:.8}]}))
  writeFileSync(join(paths.sourceDataRoot,'config.json'),config);writeFileSync(join(paths.dataRoot,'config.json'),config);writeFileSync(join(paths.sourceDataRoot,'personas/synthetic.md'),persona);writeFileSync(join(paths.sourceDataRoot,'memories.json'),jsonMemory)
  writeFileSync(join(paths.dataRoot,'sessions.json'),JSON.stringify({chats:{'private:20001':{sessionId:f.agent.id,preset:'aurabot-private',level:'full'}}}))
  const spec={paths,pins:{config:digest(config),persona:digest(persona),jsonMemory:digest(jsonMemory)},selectedPersona:'synthetic',authority:{lease:f.lease,gateway:f.gateway,holder:'local',term:f.term},signingKey:process.env.TIDEMIND_STORE_SIGNING_KEY,memoryConfig:{injectContext:true,autoCapture:true,autoCaptureMinConfidence:.75,tideEnabled:true,tideIntervalMinutes:60,dailyBackup:false,injectTokenBudget:2000},budget:20,heartbeat:{readConfig:()=>({enabled:true,intervalSeconds:600,pauseAfterMissed:3,compactBeforeBeat:false,awakeSeconds:0,prompt:'SYNTHETIC HEARTBEAT'})},externalOverrides:{
   createOneBotClient(value){options=value;return {state:'connected',start(){},stop(){lifecycle.stop++},restart(){},async call(action,params){if(action.startsWith('send_')){sent.push({action,params});return {message_id:90000+sent.length}}return action==='get_login_info'?{user_id:10001}:{}}}},
   createSnowLumaManager:()=>({running:async()=>false,detect:()=>({installed:false}),dispose(){lifecycle.dispose++},endpoint:()=>({}),lastAttach:{at:0},ownsProcess:false,webuiUrl:()=>''}),openFolder:()=>{throw Error('unexpected UI operation')},
  }}
  const start=async()=>runtime=await startExistingRuntime(f.ctx,spec)
  const event=id=>({post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:id,message:[{type:'text',data:{text:'麦克风 我喜欢合成蓝色风铃'}}],sender:{nickname:'SYNTHETIC'}})
  return {...f,loader,spec,paths,config,persona,jsonMemory,routes,sent,lifecycle,start,event,emit:e=>options.onEvent(e),cleanup:async()=>{if(runtime)await runtime.close();await f.cleanup()}}
 }catch(error){if(runtime)await runtime.close();await f.cleanup();throw error}
}
