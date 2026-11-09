// Offline candidate generations. Selecting a candidate does not enable a runtime or change a lease.
import {readFileSync,writeFileSync,realpathSync,existsSync,mkdirSync,renameSync,openSync,closeSync,fsyncSync,unlinkSync} from 'node:fs'
import {join,relative,isAbsolute} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {DatabaseSync,backup} from 'node:sqlite'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
import {assertCompositeAgreement} from './composite-head.mjs'
const slots=['memory.db','new-memories.json','persona-versions.json','ledger.jsonl']
const hash=b=>createHash('sha256').update(b).digest('hex')
const read=p=>JSON.parse(readFileSync(p,'utf8'))
function validateHead(head){const s=head?.sqlite,ack={revision:s?.revision,hash:s?.hash,data_hash:s?.dataHash,baseline_hash:s?.baseline,protected_hash:s?.protectedHash,composite:head};assertCompositeAgreement(ack,ack,{required:true})}
function durable(path,bytes){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}}
function atomic(path,value){const temp=path+'.tmp-'+randomUUID();durable(temp,JSON.stringify(value));renameSync(temp,path)}
export function createReplicaGenerations({directory,verifyGeneration}){
 const dir=checkedPath(directory);if(typeof verifyGeneration!=='function')throw Error('actual four-store verifier required')
 const owned=p=>{const f=existsSync(p)?realpathSync(p):join(realpathSync(join(p,'..')),p.split(/[\\/]/).at(-1)),r=relative(dir,f);if(!r||r.startsWith('..')||isAbsolute(r)||f!==p)throw Error('generation path changed');return f}
 const file=name=>owned(join(dir,name)),currentPath=()=>file('candidate-current.json'),pendingPath=()=>file('candidate-pending.json')
 const idCheck=id=>{if(!/^[a-f0-9]{64}$/.test(id||''))throw Error('invalid generation identity');return id}
 const pointer=()=>existsSync(currentPath())?read(currentPath()):null
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
 function locked(fn){
  const path=file('generation.lock'),nonce=randomUUID();let fd
  if(existsSync(path)){
   const prior=read(path);if(!Number.isSafeInteger(prior.pid)||prior.pid<1||typeof prior.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(prior.nonce))throw Error('unknown generation lock; review required')
   let live=true;try{process.kill(prior.pid,0)}catch(e){if(e.code==='ESRCH')live=false;else throw e}
   if(live)throw Error('generation operation already active')
   renameSync(path,file('abandoned-lock-'+prior.nonce+'.json'))
  }
  fd=openSync(path,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));closeSync(fd)
  return Promise.resolve().then(fn).finally(()=>{if(existsSync(path)&&read(path).nonce===nonce)unlinkSync(path)})
 }
 async function inspect(id){
  idCheck(id);const generation=file(id),manifest=read(owned(join(generation,'generation.json')))
  if(manifest.id!==id||manifest.head.digest!==id||!same(Object.keys(manifest.files).sort(),[...slots].sort()))throw Error('generation manifest mismatch')
  for(const name of slots)if(hash(readFileSync(owned(join(generation,name))))!==manifest.files[name])throw Error('generation content changed')
  const head=await verifyGeneration(generation);validateHead(head);if(head.digest!==id)throw Error('four-store head mismatch')
  return {id,head,directory:generation}
 }
 async function prepare({sourceFiles,head,dryRun=false}){
  validateHead(head);if(!same(Object.keys(sourceFiles).sort(),[...slots].sort()))throw Error('all four source files required')
  const sources=Object.fromEntries(slots.map(name=>[name,checkedPath(sourceFiles[name])]))
  if(dryRun)return {dryRun:true,id:head.digest,servicesChanged:false}
  return locked(async()=>{
   if(existsSync(pendingPath()))throw Error('pending candidate selection requires recovery')
   if(existsSync(file(head.digest)))return {...await inspect(head.digest),replayed:true,servicesChanged:false}
   const temp=file('prepare-'+randomUUID());mkdirSync(temp,{mode:0o700})
   // SQLite backup captures WAL consistently; sidecars are validated together before publication.
   const db=new DatabaseSync(sources['memory.db'],{readOnly:true});try{await backup(db,owned(join(temp,'memory.db')))}finally{db.close()}
   for(const name of slots.slice(1))durable(owned(join(temp,name)),readFileSync(sources[name]))
   const actual=await verifyGeneration(temp);validateHead(actual);if(actual.digest!==head.digest)throw Error('source changed or sidecars do not match expected head')
   const files=Object.fromEntries(slots.map(name=>[name,hash(readFileSync(owned(join(temp,name))))]))
   durable(owned(join(temp,'generation.json')),JSON.stringify({id:head.digest,head:actual,files}))
   renameSync(temp,file(head.digest));return {...await inspect(head.digest),replayed:false,servicesChanged:false}
  })
 }
 async function select({id,expectedCurrent=null,dryRun=false,afterStep}){
  return locked(async()=>{
   if(existsSync(pendingPath()))throw Error('pending candidate selection requires recovery')
   const next=await inspect(id),before=pointer()
   if(before){const prior=await inspect(before.id);for(const kind of ['sqlite','json','persona','aiMemory']){const old=prior.head[kind],fresh=next.head[kind];if(old.baseline!==fresh.baseline||fresh.revision<old.revision||fresh.revision===old.revision&&fresh.hash!==old.hash)throw Error('newer, branched or foreign target history must not be overwritten')}}
   if(before?.id===id)return {id,replayed:true,servicesChanged:false}
   if(!same(before,expectedCurrent))throw Error('candidate selection changed; stop')
   if(dryRun)return {id,dryRun:true,servicesChanged:false}
   const journal={before,next:{id},op:randomUUID()};atomic(pendingPath(),journal);await afterStep?.('journal')
   atomic(currentPath(),journal.next);await afterStep?.('pointer')
   atomic(file('candidate-last-change.json'),journal);unlinkSync(pendingPath())
   return {id,replayed:false,servicesChanged:false}
  })
 }
 async function recover({dryRun=false}={}){
  return locked(async()=>{
   if(!existsSync(pendingPath()))return {replayed:true,servicesChanged:false}
   const journal=read(pendingPath()),current=pointer();if(journal.next)await inspect(journal.next.id)
   if(journal.before)await inspect(journal.before.id)
   if(!same(current,journal.before)&&!same(current,journal.next))throw Error('candidate pointer changed outside interrupted selection')
   if(dryRun)return {dryRun:true,servicesChanged:false}
   if(journal.before)atomic(currentPath(),journal.before);else if(existsSync(currentPath()))unlinkSync(currentPath())
   atomic(file('recovered-'+journal.op+'.json'),journal);unlinkSync(pendingPath())
   return {restored:journal.before,dataPreserved:true,servicesChanged:false}
  })
 }
 async function rollback({expectedCurrent,dryRun=false}){
  return locked(async()=>{
   if(existsSync(pendingPath()))throw Error('recover interrupted selection first')
   const journal=read(file('candidate-last-change.json')),current=pointer()
   if(same(current,journal.before)&&same(expectedCurrent,journal.next))return {restored:journal.before,replayed:true,dataPreserved:true,servicesChanged:false}
   if(!same(current,expectedCurrent)||!same(current,journal.next))throw Error('candidate changed; refuse stale rollback')
   // If a generation received later writes, its manifest check fails: never discard those new records.
   await inspect(current.id);if(journal.before)await inspect(journal.before.id)
   if(dryRun)return {dryRun:true,servicesChanged:false}
   atomic(pendingPath(),{before:current,next:journal.before,op:randomUUID()})
   if(journal.before)atomic(currentPath(),journal.before);else unlinkSync(currentPath())
   unlinkSync(pendingPath());return {restored:journal.before,dataPreserved:true,servicesChanged:false}
  })
 }
 return Object.freeze({prepare,inspect,select,recover,rollback,current:()=>{if(existsSync(pendingPath()))throw Error('candidate recovery required');return pointer()}})
}
