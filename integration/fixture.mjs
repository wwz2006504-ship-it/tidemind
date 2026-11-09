import {mkdtempSync,mkdirSync,rmSync,realpathSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join,relative,isAbsolute,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {DatabaseSync,backup} from 'node:sqlite'
import {loadLiveStoreClass} from './store-adapter.mjs'
export const dataRoot=fileURLToPath(new URL('../data/',import.meta.url))
export async function fixture(seed=()=>{}){
 mkdirSync(dataRoot,{recursive:true});const root=mkdtempSync(join(dataRoot,'verified-'))
 process.env.TIDEMIND_SANDBOX_ROOT=root
 process.env.TIDEMIND_LEASE_DB=join(root,'lease.db')
 process.env.TIDEMIND_STORE_SIGNING_KEY='synthetic-test-signing-key-at-least-32-characters'
 process.env.TIDEMIND_REQUIRE_STORE_PROOF='1'
 let fixtureStore
 if(process.env.TIDEMIND_FIXTURE_STORE){
  if(process.env.TIDEMIND_FIXTURE_STORE!=='isolated-pinned')throw Error('unknown test store mode')
  fixtureStore=fileURLToPath(new URL('../host/plugin/src/store.js',import.meta.url))
  const pin=JSON.parse(readFileSync(new URL('../host/SOURCE-MANIFEST.json',import.meta.url),'utf8'))['store.js'].isolatedSha256
  if(createHash('sha256').update(readFileSync(fixtureStore)).digest('hex')!==pin)throw Error('isolated test store source drift')
 }
 const {MemoryStore}=await loadLiveStoreClass(fixtureStore)
 const localDir=join(root,'local');mkdirSync(localDir)
 const raw=new MemoryStore(localDir)
 raw.writePersona({key:'self',content:'SYNTHETIC XIYU IDENTITY'},1)
 const core=raw.write({layer:'core',content:'SYNTHETIC IMMUTABLE CORE',source:'tool'},1)
 await seed(raw);raw.close()
 const local=join(localDir,'memory.db'),cloudDir=join(root,'cloud');mkdirSync(cloudDir)
 const cloud=join(cloudDir,'memory.db'),ro=new DatabaseSync(local,{readOnly:true})
 await backup(ro,cloud);ro.close()
 const leaseMod=await import('../TideMind/deploy/existing/lease.mjs')
 const gateway=await import('../TideMind/deploy/existing/tide-gateway.mjs')
 const replica=await import('../TideMind/deploy/existing/tide-replica.mjs')
 const file=join(root,'lease.db')
 const lease={openAuthority:()=>leaseMod.openAuthority(file),
  acquire:(h,o={})=>leaseMod.acquire(h,{...o,file}),renew:(h,t,o={})=>leaseMod.renew(h,t,{...o,file}),
  release:(h,t)=>leaseMod.release(h,t,{file}),status:()=>leaseMod.status(file),
  fenced:(h,t,cb,o={})=>leaseMod.fenced(h,t,cb,{...o,file})}
 replica.initializeReplica(local);replica.initializeReplica(cloud)
 gateway.initialize(lease,{protectedIds:[core.id],baseline:replica.replicaHead(local)})
 const term=lease.acquire('local',{ttl:60000}).term
 const read=(sql,...args)=>{const db=new DatabaseSync(local,{readOnly:true});try{return db.prepare(sql).all(...args)}finally{db.close()}}
 const cleanup=()=>{const r=relative(realpathSync(dataRoot),realpathSync(root));if(!r||r.startsWith('..')||isAbsolute(r))throw new Error('unsafe cleanup');rmSync(root,{recursive:true,force:true})}
 return {root,localDir,local,cloud,lease,gateway,replica,term,read,cleanup,core,MemoryStore}
}
