// Uses SQLite online backup, the installed ORIGINAL MemoryStore, and the SAME
// lease authority. Original-store multi-row changes are committed atomically.
import {DatabaseSync,backup} from 'node:sqlite'
import {mkdtempSync,rmSync,realpathSync} from 'node:fs'
import {homedir} from 'node:os'
import {join,relative,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import * as replica from '../TideMind/deploy/existing/tide-replica.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {writable,tableRows,storeHash,identityHash,sealBatch} from './store-batch.mjs'
const LIVE_STORE_SRC=process.env.TIDEMIND_LIVE_STORE||join(homedir(),'.dsh','profiles','desktop','node_modules','dsh-memory-layers','src','store.js')
export async function loadLiveStoreClass(srcPath=LIVE_STORE_SRC){return import(pathToFileURL(srcPath).href)}
function cleanup(path){const root=realpathSync(process.env.TIDEMIND_SANDBOX_ROOT),r=relative(root,realpathSync(path));if(!r||r.startsWith('..')||isAbsolute(r))throw new Error('unsafe cleanup');rmSync(path,{recursive:true,force:true})}
export async function prepareStoreOperation(srcDbPath,operation,{MemoryStore,requestHash,commitContext=null}={}){
 replica.checkedPath(srcDbPath)
 if(!['write','update','expireTide'].includes(operation.method))throw new Error('unsupported/protected store operation')
 const fields=operation.method==='update'?operation.args?.[1]:operation.args?.[0]
 const allowed=operation.method==='write'?new Set(['layer','category','content','key','tags','importance','confidence','status','source','source_session','source_turn','source_ref','meta','rule','norm_hash','valid_to','superseded_by','created_at','updated_at']):operation.method==='update'?new Set(['id','content','tags','importance','confidence','status']):new Set(['maturingDays','retireDays','workingDays'])
 const unknown=Object.keys(fields||{}).filter(k=>!allowed.has(k))
 if(unknown.length){const note='unsupported field: '+unknown.join(',');return {action:'rejected',storeNote:note,storeResult:{action:'rejected',note}}}

 const Store=MemoryStore||(await loadLiveStoreClass()).MemoryStore
 const scratch=mkdtempSync(join(realpathSync(process.env.TIDEMIND_SANDBOX_ROOT),'.store-plan-'))
 let source,store,sessions=[]
 try{
  source=new DatabaseSync(srcDbPath,{readOnly:true});source.exec('PRAGMA query_only=ON')
  await backup(source,join(scratch,'memory.db'));source.close();source=null
  store=new Store(scratch)
  const before=storeHash(store.db),protectedBefore=identityHash(store.db)
  const previous=tableRows(store.db,'memories')
  sessions=writable.map(table=>({table,session:store.db.createSession({table})}))
  const {method,args=[],now}=operation
  if(!['write','update','expireTide'].includes(method))throw new Error('unsupported/protected store operation')
  if(method==='write'&&(args[0]?.layer==='core'||args[0]?.category==='persona'))throw new Error('protected identity')
  if(method==='update'&&previous.find(r=>r.id===String(args[0]))?.layer==='core')throw new Error('protected core')
  const result=now===undefined?store[method](...args):store[method](...args,now)
  if(result?.action==='rejected'||result?.ok===false)return {action:'rejected',storeResult:result}
  // Installed store retires same-key predecessors but leaves superseded_by NULL.
  // Complete the existing schema's link on the CLONE, never on the source.
  if(method==='write'&&result?.action==='created'&&args[0]?.key){
   for(const old of previous.filter(r=>r.key===args[0].key&&r.layer===(args[0].layer||'semantic')&&r.status==='active')){
    store.db.prepare("UPDATE memories SET superseded_by=? WHERE id=? AND status='superseded' AND superseded_by IS NULL").run(result.id,old.id)
   }
  }
  if(identityHash(store.db)!==protectedBefore)throw new Error('identity changed during original-store operation')
  const after=storeHash(store.db),next=tableRows(store.db,'memories')
  const touched=next.filter(r=>JSON.stringify(r)!==JSON.stringify(previous.find(p=>p.id===r.id))).map(r=>r.id)
  if(previous.some(r=>!next.some(n=>n.id===r.id)))throw new Error('hard delete not authorized')
  const changesets=sessions.map(({table,session})=>({table,data:Buffer.from(session.changeset()).toString('base64')})).filter(x=>x.data)
  const batch=sealBatch({format:'original-store-session-v1',before,after,protected:protectedBefore,
   requestHash:requestHash||hash(operation),commitContext,changesets,touched,storeResult:result})
  if(Buffer.byteLength(JSON.stringify(batch))>48*1024)throw new Error('store batch exceeds reviewed transport budget')
  return {action:result?.action||'accepted',storeResult:result,batch}
 }finally{for(const {session}of sessions)session.close();if(store)store.close();if(source)source.close();cleanup(scratch)}
}
export async function decideWithStore(srcDbPath,mutation,options={}){
 const decision=await prepareStoreOperation(srcDbPath,{method:'write',args:[mutation.fields]},options)
 return {...decision,action:['duplicate','rejected'].includes(decision.action)?decision.action:'accepted'}
}
export async function executeStoreOperation({gateway,lease,holder,term,srcDbPath,operation,op,expectedRevision,expectedHash}){
 const requestHash=hash(operation)
 const existing=gateway.committedSince(lease,0).find(r=>r.op===op)
 if(existing){
  if(existing.mutation.requestHash!==requestHash)throw new Error('operation conflict')
  const receipt=gateway.commit(lease,holder,term,{op,expectedRevision,expectedHash,mutation:existing.mutation})
  const current=replica.replicaHead(srcDbPath)
  replica.materialize(srcDbPath,gateway.committedSince(lease,current.revision),{expected:current,sourceHead:gateway.head(lease),home:holder})
  return {committed:true,replayed:true,result:existing.mutation.storeResult,receipt}
 }
 const local=replica.replicaHead(srcDbPath),head=gateway.head(lease)
 if(local.revision!==head.revision||local.hash!==head.hash||head.revision!==expectedRevision||head.hash!==expectedHash)throw new Error('revision conflict; recover pending materialization first')
 const decision=await prepareStoreOperation(srcDbPath,operation,{requestHash,commitContext:{op,holder,term,revision:expectedRevision,hash:expectedHash}})
 if(decision.action==='rejected')return {committed:false,result:decision.storeResult}
 if(decision.batch.before===decision.batch.after){
  lease.fenced(holder,term,db=>{const h=db.prepare('SELECT revision,hash FROM tide_head').get();if(h.revision!==expectedRevision||h.hash!==expectedHash)throw new Error('revision conflict')})
  return {committed:false,noChange:true,result:decision.storeResult}
 }
 const receipt=gateway.commit(lease,holder,term,{op,expectedRevision,expectedHash,mutation:decision.batch})
 // No success until the committed changeset has REALLY reached the local table.
 replica.materialize(srcDbPath,gateway.committedSince(lease,local.revision),{expected:local,sourceHead:gateway.head(lease),home:holder})
 return {committed:true,replayed:false,result:decision.storeResult,receipt}
}
export async function storeThenCommit(options){
 const operation={method:'write',args:[options.mutation.fields]}
 const result=await executeStoreOperation({...options,operation})
 return {...result,stage:result.committed?'materialized':'store',decision:{action:result.result.action==='created'?'accepted':result.result.action},committed_result:result.receipt}
}
