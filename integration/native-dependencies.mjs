// Assemble original peripheral implementations. Importing does not start them.
import {spawn} from 'node:child_process'
import {mkdirSync} from 'node:fs'
import {createOneBotClient} from '../host/aurabot/src/onebot/client.js'
import {createSnowLumaManager,DOWNLOAD_PAGE} from '../host/aurabot/src/snowluma/manager.js'
import {createLocal,fileOf,toImageBuffer} from '../host/aurabot/src/local/local.js'
import {createUpdateChecker,changelogSection} from '../host/aurabot/src/core/update.js'
import {parseCommand,runCommand,createMutes,commandList} from '../host/aurabot/src/chat/commands.js'
import * as personas from '../host/aurabot/src/persona/personas.js'
import {createBridge} from '../host/aurabot/src/core/bridge.js'
import {BUILTINS as ORIGINAL_BUILTINS} from '../host/aurabot/src/modules/index.js'
import taskControl from './tidemind-control.mjs'
import {CLOUD_MODULES} from './cloud-host-policy.mjs'
const BUILTINS=[...ORIGINAL_BUILTINS,taskControl]
export function nativeDependencies({cloud=false}={}){
 const dependencies={createOneBotClient,createSnowLumaManager,DOWNLOAD_PAGE,createLocal,fileOf,toImageBuffer,createUpdateChecker,changelogSection,parseCommand,runCommand,createMutes,commandList,...personas,createBridge,BUILTINS,openFolder(dir){mkdirSync(dir,{recursive:true});spawn('explorer.exe',[dir],{detached:true,stdio:'ignore',windowsHide:true}).unref();return {ok:true,message:'打开了'}}}
 if(!cloud)return dependencies
 const denied=()=>{throw Error('local computer capability unavailable to cloud host')}
 return {...dependencies,BUILTINS:BUILTINS.filter(m=>CLOUD_MODULES.has(m.id)),openFolder:denied,createLocal:()=>({dir:()=>'',status:()=>[],active:()=>false,call:denied}),createSnowLumaManager:()=>({running:async()=>false,detect:()=>({installed:false}),start:denied,stop:denied,attachBot:denied,dispose(){},endpoint:()=>({}),lastAttach:{at:0},ownsProcess:false,webuiUrl:()=>''})}
}
