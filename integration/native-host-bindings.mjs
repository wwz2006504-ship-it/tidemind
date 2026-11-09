import {assertMemoryWritesOpen} from './memory-barrier.mjs'
// Binding factory for the original host, not another QQ or memory entrypoint.
import {nativeDependencies} from './native-dependencies.mjs'
import {bindReadonlyIdentity} from '../host/aurabot/src/persona/personas.js'
import {useSessionBindings} from './fenced-store.mjs'
import {assertCognitiveActive} from './activity-gate.mjs'
import {assertCloudConfig,CLOUD_TOOLS} from './cloud-host-policy.mjs'
export function createNativeHostBindings({authority,identity,protectedMemory,taskSupervisor,activityAgent,resolveActivityAgent,sourceAdmission,sessionBindings,allowTargets,historyReader,heartbeat,externalOverrides={},createCapabilities}){
 const remote=authority?.mode==='remote',cloud=authority?.holder==='cloud'
 if(!['local','cloud'].includes(authority?.holder)||cloud&&!remote||(remote?typeof authority.request!=='function'||typeof createCapabilities!=='function':typeof authority?.lease?.fenced!=='function'||typeof authority?.gateway?.head!=='function')||!taskSupervisor||!activityAgent?.session?.id||activityAgent.id!==activityAgent.session.id||typeof historyReader!=='function'||!Array.isArray(allowTargets)||!allowTargets.length)throw Error('complete existing host context required')
 if(protectedMemory?.inspect?.().sourceReadOnly!==true||identity?.inspect?.().originalReadOnly!==true)throw Error('reviewed original identity and JSON memory binding required')
 const dependencies=nativeDependencies({cloud})
 for(const key of Object.keys(externalOverrides))if(!(cloud?['createOneBotClient']:['createOneBotClient','createSnowLumaManager','openFolder']).includes(key))throw Error('unreviewed native dependency override')
 sessionBindings.authorize(activityAgent,sessionBindings.ownerChatId)
 // Remote adapters publish only after their asynchronous original authority commit.
 // Never wrap an HTTP call in a pretend synchronous lease.fenced implementation.
 const fencedWrite=fn=>{assertCognitiveActive();if(remote)return fn();const term=typeof authority.term==='function'?authority.term():authority.term;return authority.lease.fenced('local',term,db=>{assertMemoryWritesOpen(db);if(db.prepare('SELECT home FROM tide_head').get().home!=='local')throw Error('standby identity and memory are read-only');return fn()})}
 const guardedIdentity=Object.freeze({...identity,savePersona:(...args)=>fencedWrite(()=>identity.savePersona(...args)),deletePersona:(...args)=>fencedWrite(()=>identity.deletePersona(...args))})
 const off=bindReadonlyIdentity(guardedIdentity)
 try{useSessionBindings(sessionBindings)}catch(error){off();throw error}
 const guardedMemory=Object.freeze({...protectedMemory,save:state=>fencedWrite(()=>protectedMemory.save(state))})
 return {bindings:{isolated:true,dependencies:{...dependencies,...externalOverrides},authority,protectedMemory:guardedMemory,taskSupervisor,...(cloud?{validateConfig:assertCloudConfig,toolFilter:tool=>CLOUD_TOOLS.has(tool.name),runtimeContext:'当前运行在云端待命机，沿用同一身份与连续经历。这里提供聊天和记忆，不具备主人本机的屏幕、麦克风、桌面、文件或游戏操作权限。'}:{}),...(remote?{createCapabilities,remoteTaskControl:taskSupervisor}:{}),activityAgent,resolveActivityAgent,sourceAdmission,assertActivityAgent:agent=>sessionBindings.authorize(agent,sessionBindings.ownerChatId),sessionBindings,allowTargets,historyReader,heartbeat},dispose:off}
}
