// Read-only preflight for the desktop profile transaction.
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createAuthorityClient} from './authority-client.mjs'
import {verifyFreshBaseline} from './fresh-baseline.mjs'

const [root,mode]=process.argv.slice(2)
const read=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''))
try{
 const input=read(join(root,'runtime/profile-runtime-inputs.json'))
 const {env}=read(join(root,'runtime/service-config.json'))
 if(input.authorityMode!=='remote'||input.authorityHolder!=='local'||
    env.TIDEMIND_PROFILE_AUTHORITY!=='remote'||env.TIDEMIND_PROFILE_HOLDER!=='local'||
    input.authorityUrl!==env.TIDEMIND_AUTHORITY_URL||!input.aiMemory||
    env.TIDEMIND_ALLOW_LEGACY_SYNTHETIC!=='0'||env.TIDEMIND_REQUIRE_STORE_PROOF!=='1'){
  throw Error('Shared production authority and four-store inputs required')
 }
 const client=createAuthorityClient({url:input.authorityUrl,token:env.TIDEMIND_LOCAL_TOKEN})
 const report=await client.request('/activation/status')
 if(report.head?.home!=='local'||report.lease?.valid!==false||report.lease?.holder!==null||
    !Number.isSafeInteger(report.lease.term))throw Error('Local home and unheld authority required')
 const hex=value=>/^[a-f0-9]{64}$/.test(value||'')
 if(!hex(report.storeDigest)||!hex(report.historyDigest))throw Error('Missing authority frontiers')
 if(mode==='apply'){
  if(!report.gateways?.local||!report.gateways?.cloud||
     input.activation?.storeDigest!==report.storeDigest||input.activation?.historyDigest!==report.historyDigest||
     report.head.baseline_hash!==input.freshBaseline?.source?.hash){
   throw Error('Reviewed frontiers and both verified QQ gateways required')
  }
  const source=input.paths.sourceDataRoot
  const snapshotFiles={
   hub:fileURLToPath(new URL('../host/aurabot-upstream/src/chat/hub.js',import.meta.url)),
   reply:fileURLToPath(new URL('../host/aurabot-upstream/src/chat/reply.js',import.meta.url)),
   identity:join(source,'personas',input.selectedPersona+'.md'),
   jsonMemory:join(source,'memories.json'),config:join(source,'config.json'),
   sessions:join(source,'sessions.json'),aiMemory:input.aiMemory.source,
  }
  verifyFreshBaseline(input.freshBaseline,{local:env.TIDEMIND_DB,requireAi:true,snapshotFiles})
 }
 console.log(JSON.stringify({term:report.lease.term,storeDigest:report.storeDigest,historyDigest:report.historyDigest}))
}catch(error){
 console.error(error.status===423?'Cloud authority is in standby or has incomplete production wiring':error.message)
 process.exitCode=1
}
