// Actual asynchronous original-store commit over the existing authority HTTP API.
// No local authority DB and no pretend synchronous RPC fence.
import {readFileSync,existsSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {prepareStoreOperation} from './store-adapter.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import * as replica from '../TideMind/deploy/existing/tide-replica.mjs'
export function createRemoteStoreExecutor({authority,holder='local',term,local,journalDirectory,MemoryStore}){
 if(typeof authority?.request!=='function'||!['local','cloud'].includes(holder)||!Number.isSafeInteger(term)||term<1)throw Error('remote authority and explicit acquired term required')
 const file=replica.checkedPath(local),journal=join(replica.checkedPath(journalDirectory),'pending-store.json')
 const path=()=>{replica.checkedPath(journal);if(existsSync(journal)&&realpathSync(journal)!==journal)throw Error('remote pending journal link refused');return journal}
 const read=()=>existsSync(path())?JSON.parse(readFileSync(journal,'utf8')):null
 const save=record=>{path();const temp=journal+'.tmp-'+randomUUID(),fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(record));fsyncSync(fd)}finally{closeSync(fd)}renameSync(temp,journal)}
 let queue=Promise.resolve()
 async function owner(){const grant=await authority.request('/admin',{command:'status'});if(grant.holder!==holder||grant.term!==term||!Number.isFinite(grant.expiresAt)&&!Number.isFinite(grant.expires_at))throw Error('remote source fenced');const expires=grant.expiresAt??grant.expires_at;if(expires<=Date.now())throw Error('remote source lease expired');const head=await authority.request('/head',{});if(head.home!==holder)throw Error('remote source is standby');return head}
 async function materialize(status){
  const before=replica.replicaHead(file),entries=await authority.request('/entries',{after:before.revision}),head=await owner()
  replica.materialize(file,entries.entries,{expected:before,sourceHead:head,home:holder})
  await owner();return {committed:true,replayed:true,result:status.result,receipt:{revision:status.revision,hash:status.hash},remote:true}
 }
 async function execute({operation,op,retryUnaccepted=false,queryOnly=false}){
  if(typeof op!=='string'||!op||op.length>200)throw Error('stable bounded store operation required')
  const requestHash=hash(operation),head=await owner(),pending=read()
  if(pending&&(pending.format!=='remote-store-pending-v1'||pending.op!==op||pending.requestHash!==requestHash))throw Error('unresolved or conflicting store operation; recover before new writes')
  if(pending&&(hash(pending.body)!==pending.bodyHash||hash(pending.operation)!==requestHash||pending.body.op!==op||pending.body.mutation.requestHash!==requestHash))throw Error('remote pending journal changed; stop')
  const status=await authority.request('/operation',{op})
  if(status.op!==op||typeof status.found!=='boolean')throw Error('invalid remote operation status')
  if(status.found){if(status.requestHash!==requestHash||status.holder!==holder)throw Error('remote operation payload conflict');const result=await materialize(status);if(pending)unlinkSync(path());return result}
  if(queryOnly)return {resolved:false,pending:true,op,state:pending?.state}
  let record=pending
  if(record&&record.body.term!==term)throw Error('pending operation belongs to another term; review required')
  if(record?.state==='submitted'&&!retryUnaccepted)throw Error('store outcome unknown; query/review before exact retry')
  if(record&&!['prepared','submitted'].includes(record.state))throw Error('unknown remote store journal state')
  const current=replica.replicaHead(file)
  if(current.revision!==head.revision||current.hash!==head.hash||current.baseline_hash!==head.baseline_hash||current.protected_hash!==head.protected_hash)throw Error('local SQL replica differs from remote authority; recover before writing')
  if(!record){
   const plan=await prepareStoreOperation(file,operation,{MemoryStore,requestHash,commitContext:{op,holder,term,revision:head.revision,hash:head.hash}})
   if(plan.action==='rejected')return {committed:false,result:plan.storeResult,remote:true}
   if(plan.batch.before===plan.batch.after){const final=await owner();if(final.revision!==head.revision||final.hash!==head.hash)throw Error('remote authority advanced during no-op');return {committed:false,noChange:true,result:plan.storeResult,remote:true}}
   const body={op,term,expectedRevision:head.revision,expectedHash:head.hash,mutation:plan.batch}
   record={format:'remote-store-pending-v1',op,operation,requestHash,state:'prepared',body,bodyHash:hash(body)};save(record)
  }
  record.state='submitted';save(record)
  let receipt
  try{receipt=await authority.request('/commit',record.body)}catch(error){throw Error('remote store outcome unresolved; pending journal retained',{cause:error})}
  const accepted=await authority.request('/operation',{op})
  if(!accepted.found||accepted.requestHash!==requestHash||accepted.revision!==receipt.revision||accepted.hash!==receipt.hash)throw Error('remote commit receipt differs; stop')
  const result=await materialize(accepted);unlinkSync(path());return {...result,replayed:receipt.replayed===true}
 }
 const submit=options=>{const job=queue.then(()=>execute(options));queue=job.catch(()=>{});return job}
 return {submit,recover:()=>{const p=read();return p?submit({op:p.op,operation:p.operation,queryOnly:true}):Promise.resolve({resolved:true,pending:false})},idle:()=>queue,pending:()=>{const p=read();return p?{op:p.op,state:p.state,requestHash:p.requestHash}:null}}
}
