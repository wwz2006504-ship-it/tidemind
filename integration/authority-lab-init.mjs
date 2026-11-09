// Persistent synthetic baseline for the ORIGINAL lease.mjs serve entrypoint.
// No user profile, persona, QQ credential or private memory paths are accepted.
import {mkdirSync,existsSync,readFileSync,writeFileSync,realpathSync,lstatSync,renameSync,chmodSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomBytes,createHash} from 'node:crypto'
import {MemoryStore} from '../host/plugin/src/store.js'
import * as replica from '../TideMind/deploy/existing/tide-replica.mjs'
import {setupOriginals} from './state-transfer-fixture.mjs'
import {createSidecarAuthority} from './sidecar-authority.mjs'
import {spawnSync} from 'node:child_process'
const root='/srv/tidemind-staging/authority-lab',tag='TideMind isolated authority lab v1',args=process.argv.slice(2)
if(args.includes('--dry-run')||args.includes('--rollback'))console.log(JSON.stringify({dryRun:args.includes('--dry-run'),rollback:args.includes('--rollback'),root,productionEnabled:false,rollbackAction:'use cloud-authority-lab.py --rollback; baseline and authority DB are retained'}))
else{
 if(process.platform!=='linux')throw Error('Linux lab only')
 if(realpathSync('/srv/tidemind-staging')!=='/srv/tidemind-staging'||readFileSync('/srv/tidemind-staging/OWNER','utf8')!=='TideMind candidate staging v1')throw Error('owned staging root required')
 if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw Error('lab links refused')
 process.env.TIDEMIND_SANDBOX_ROOT=root;process.env.TIDEMIND_LEASE_DB=join(root,'lease.db')
 const source=fileURLToPath(new URL('../',import.meta.url)),owner=join(root,'OWNER'),config=join(root,'lab-config.json'),envFile=join(root,'authority.env')
 if(existsSync(root)){
  if(!existsSync(owner)||lstatSync(owner).isSymbolicLink()||readFileSync(owner,'utf8')!==tag)throw Error('unowned authority lab')
  for(const p of [config,envFile])if(!existsSync(p)||lstatSync(p).isSymbolicLink())throw Error('incomplete or linked lab; review without overwriting')
  const meta=JSON.parse(readFileSync(config,'utf8')),oldEnv=readFileSync(envFile,'utf8')
  if(createHash('sha256').update(oldEnv).digest('hex')!==meta.environmentSha256)throw Error('lab private environment drift')
  if(meta.source!==source){
   if(!args.includes('--retarget-uninstalled')||existsSync('/etc/systemd/system/tidemind-authority-lab.service'))throw Error('lab code release differs; explicit uninstalled upgrade required')
   const {createConnection}=await import('node:net');const alive=await new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port:5191});socket.once('connect',()=>{socket.destroy();resolve(true)});socket.once('error',()=>resolve(false))});if(alive)throw Error('stop the lab authority before code upgrade')
   writeFileSync(config+'.before-'+createHash('sha256').update(meta.source).digest('hex').slice(0,12),JSON.stringify(meta),{flag:'wx',mode:0o600});meta.source=source
  }
  const current=replica.replicaHead(join(root,'baseline','memory.db'));if(current.baseline_hash!==meta.baseline.baseline_hash||current.protected_hash!==meta.baseline.protected_hash)throw Error('lab baseline changed')
  const specFile=join(root,'state-spec.json')
  if(!existsSync(specFile)){
   const originals=setupOriginals(root);for(const name of ['memories.json','ai-original.jsonl','personas/synthetic.md'])chmodSync(join(originals.source,name),0o600)
   const spec={sourceDataRoot:originals.source,selectedPersona:'synthetic',pins:originals.pins,aiSource:join(originals.source,'ai-original.jsonl'),aiBaselineSha256:createHash('sha256').update(readFileSync(join(originals.source,'ai-original.jsonl'))).digest('hex'),sqlBaselineFile:join(root,'baseline/memory.db')}
   const lease=await import('../TideMind/deploy/existing/lease.mjs');createSidecarAuthority({lease,spec})
   const specBytes=JSON.stringify(spec);writeFileSync(specFile,specBytes,{flag:'wx',mode:0o600});meta.sidecarSpecSha256=createHash('sha256').update(specBytes).digest('hex')
   const nextEnv=oldEnv+"TIDEMIND_STATE_SPEC='"+specFile+"'\n";writeFileSync(envFile+'.before-state',oldEnv,{flag:'wx',mode:0o600});writeFileSync(envFile+'.tmp',nextEnv,{flag:'wx',mode:0o600});renameSync(envFile+'.tmp',envFile);meta.environmentSha256=createHash('sha256').update(nextEnv).digest('hex')
  }else if(createHash('sha256').update(readFileSync(specFile)).digest('hex')!==meta.sidecarSpecSha256)throw Error('sidecar spec drift')
  writeFileSync(config+'.tmp',JSON.stringify(meta),{flag:'wx',mode:0o600});renameSync(config+'.tmp',config)
  console.log(JSON.stringify({prepared:true,replayed:true,root,source,envFile,sidecarsConfigured:true,productionEnabled:false}))
 }else{
  mkdirSync(root,{mode:0o700});writeFileSync(owner,tag,{mode:0o600,flag:'wx'});const base=join(root,'baseline');mkdirSync(base,{mode:0o700})
  const store=new MemoryStore(base);store.writePersona({key:'self',content:'SYNTHETIC CLOUD AUTHORITY LAB IDENTITY'},1);const core=store.write({layer:'core',content:'SYNTHETIC CLOUD AUTHORITY IMMUTABLE CORE',source:'tool'},1);store.write({layer:'semantic',content:'合成检索标记 麦克风 调试约定',source:'tool'},1);store.close();replica.initializeReplica(join(base,'memory.db'))
  const baseline=replica.replicaHead(join(base,'memory.db')),lease=await import('../TideMind/deploy/existing/lease.mjs'),gateway=await import('../TideMind/deploy/existing/tide-gateway.mjs')
  gateway.initialize(lease,{protectedIds:[core.id],baseline});const hex=()=>randomBytes(32).toString('hex')
  const env={TIDEMIND_SANDBOX_ROOT:root,TIDEMIND_LEASE_DB:join(root,'lease.db'),TIDEMIND_AUTHORITY_PORT:'5191',TIDEMIND_STORE_SIGNING_KEY:hex(),TIDEMIND_SYNC_SIGNING_KEY:hex(),TIDEMIND_LOCAL_TOKEN:hex(),TIDEMIND_CLOUD_TOKEN:hex(),TIDEMIND_LOCAL_MATERIALIZER_KEY:hex(),TIDEMIND_CLOUD_MATERIALIZER_KEY:hex(),TIDEMIND_PROTECTED_IDS:JSON.stringify([core.id]),TIDEMIND_BASELINE_DATA_HASH:baseline.baseline_hash,TIDEMIND_BASELINE_PROTECTED_HASH:baseline.protected_hash,TIDEMIND_AUTHORITY_STANDBY:'0',TIDEMIND_REQUIRE_STORE_PROOF:'1',TIDEMIND_ALLOW_LEGACY_SYNTHETIC:'0'}
  const text=Object.entries(env).map(([k,v])=>k+'='+"'"+v+"'").join('\n')+'\n';writeFileSync(envFile,text,{mode:0o600,flag:'wx'})
  writeFileSync(config,JSON.stringify({tag,source,baseline,protectedIds:[core.id],environmentSha256:createHash('sha256').update(text).digest('hex')}),{mode:0o600,flag:'wx'})
  const complete=spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{encoding:'utf8'})
  if(complete.status!==0)throw Error('sidecar bootstrap incomplete; retain lab for review')
  console.log(JSON.stringify({...JSON.parse(complete.stdout),replayed:false}))
 }
}
