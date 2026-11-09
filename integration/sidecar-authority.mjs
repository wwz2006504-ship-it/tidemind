// Canonical non-SQL state journal inside the SAME original authority DB.
// Actual original adapters validate each proposed body; no second lease or memory engine.
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync,copyFileSync,constants} from 'node:fs'
import {join,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
import {createProtectedJsonMemory} from './protected-json-memory.mjs'
import {createIdentityBinding} from './identity-binding.mjs'
import {createPersonaVersions} from './persona-versions.mjs'
import {createProtectedAiMemory} from './protected-ai-memory.mjs'
import {assertMemoryWritesOpen} from './memory-barrier.mjs'
import {createCompositeHead} from './composite-head.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import * as replica from '../TideMind/deploy/existing/tide-replica.mjs'
const files={json:'new-memories.json',persona:'persona-versions.json',aiMemory:'ledger.jsonl'},sha=b=>createHash('sha256').update(b).digest('hex')
const opId=op=>{if(typeof op!=='string'||!op||op.length>200)throw Error('bounded sidecar operation required')}
export function createSidecarAuthority({lease,spec}){
 const root=realpathSync(process.env.TIDEMIND_SANDBOX_ROOT),source=realpathSync(spec.sourceDataRoot),scratch=join(root,'state-validation')
 const within=p=>{const actual=realpathSync(p),r=relative(root,actual);if(!r||r.startsWith('..')||isAbsolute(r))throw Error('sidecar original outside owned authority root');return actual}
 within(source);within(spec.aiSource);within(spec.sqlBaselineFile);mkdirSync(scratch,{recursive:true,mode:0o700})
 const cacheDir=join(root,'state-sql-cache');mkdirSync(cacheDir,{recursive:true,mode:0o700});const sqlCache=join(cacheDir,'memory.db')
 if(!existsSync(sqlCache)){const before=replica.replicaHead(spec.sqlBaselineFile);copyFileSync(spec.sqlBaselineFile,sqlCache,constants.COPYFILE_EXCL);if(hash(before)!==hash(replica.replicaHead(sqlCache))||hash(before)!==hash(replica.replicaHead(spec.sqlBaselineFile)))throw Error('immutable SQL baseline changed during cache preparation')}
 const readonly=()=>{throw Error('authority validator is read-only')}
 function inspect(component,body){
  if(!Object.hasOwn(files,component)||typeof body!=='string'||Buffer.byteLength(body)>1024*1024)throw Error('bounded sidecar body required')
  const dir=mkdtempSync(join(scratch,'validate-'));try{
   writeFileSync(join(dir,files[component]),body,{mode:0o600})
   let r
   if(component==='json'){r=createProtectedJsonMemory({source:join(source,'memories.json'),expectedSha256:spec.pins.jsonMemory,ownedRoot:root,overlay:join(dir,files.json),withWriteGuard:readonly}).inspect();r={revision:r.overlayRevision,digest:r.overlayHash,baseline:r.baselineSha256}}
   else if(component==='persona'){r=createPersonaVersions({identity:createIdentityBinding({directory:join(source,'personas'),selected:spec.selectedPersona,expectedSha256:spec.pins.persona}),ownedRoot:root,stateFile:join(dir,files.persona),withWriteGuard:readonly}).inspect();r={revision:r.overlayVersion,digest:r.currentHash,baseline:r.sha256}}
   else{r=createProtectedAiMemory({source:spec.aiSource,baselineSha256:spec.aiBaselineSha256,ownedRoot:root,directory:dir,withWriteGuard:readonly}).inspect();r={revision:r.revision,digest:r.hash,baseline:r.baseline}}
   if(!Number.isSafeInteger(r.revision)||r.revision<0)throw Error('invalid sidecar revision')
   return {...r,fileHash:sha(body)}
  }finally{rmSync(dir,{recursive:true,force:true})}
 }
 const initial={json:JSON.stringify({items:[],rev:0,overlayRevision:0,baselineSha256:spec.pins.jsonMemory}),persona:JSON.stringify({format:'tidemind-persona-v1',selected:spec.selectedPersona,baseHash:spec.pins.persona,versions:[]}),aiMemory:readFileSync(spec.aiSource,'utf8')}
 const db=lease.openAuthority();try{
  db.exec(`CREATE TABLE IF NOT EXISTS tide_sidecar_states(component TEXT PRIMARY KEY,revision INTEGER NOT NULL,digest TEXT NOT NULL,baseline TEXT NOT NULL,file_hash TEXT NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS tide_sidecar_log(op TEXT PRIMARY KEY,request_hash TEXT NOT NULL,component TEXT NOT NULL,holder TEXT NOT NULL,term INTEGER NOT NULL,previous_revision INTEGER NOT NULL,previous_digest TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,file_hash TEXT NOT NULL,body TEXT NOT NULL,operation_hash TEXT NOT NULL,result TEXT NOT NULL);`)
  const columns=db.prepare('PRAGMA table_info(tide_sidecar_log)').all().map(r=>r.name);if(!columns.includes('operation_hash'))db.exec("ALTER TABLE tide_sidecar_log ADD COLUMN operation_hash TEXT NOT NULL DEFAULT ''");if(!columns.includes('result'))db.exec("ALTER TABLE tide_sidecar_log ADD COLUMN result TEXT NOT NULL DEFAULT 'null'")
  db.exec('BEGIN IMMEDIATE')
  for(const [component,body]of Object.entries(initial)){const r=inspect(component,body),old=db.prepare('SELECT * FROM tide_sidecar_states WHERE component=?').get(component);if(old){const actual=inspect(component,old.body);if(old.baseline!==r.baseline||actual.revision!==old.revision||actual.digest!==old.digest||actual.fileHash!==old.file_hash)throw Error('canonical sidecar drift')}else db.prepare('INSERT INTO tide_sidecar_states VALUES(?,?,?,?,?,?)').run(component,r.revision,r.digest,r.baseline,r.fileHash,body)}
  db.exec('COMMIT')
 }catch(e){try{db.exec('ROLLBACK')}catch{}throw e}finally{db.close()}
 const publicRow=row=>({component:row.component,revision:row.revision,digest:row.digest,baseline:row.baseline,fileHash:row.file_hash,body:row.body})
 function current(component){if(!Object.hasOwn(files,component))throw Error('unknown sidecar');const db=lease.openAuthority();try{return publicRow(db.prepare('SELECT * FROM tide_sidecar_states WHERE component=?').get(component))}finally{db.close()}}
 function status(op){opId(op);const db=lease.openAuthority();try{const r=db.prepare('SELECT * FROM tide_sidecar_log WHERE op=?').get(op);return r?{found:true,op,requestHash:r.request_hash,operationHash:r.operation_hash,result:JSON.parse(r.result),component:r.component,holder:r.holder,term:r.term,revision:r.revision,digest:r.digest,fileHash:r.file_hash}:{found:false,op}}finally{db.close()}}
 function commit(holder,term,{op,component,expected,body,operationHash,result=null}){
  opId(op);if(!Object.hasOwn(files,component)||!expected)throw Error('sidecar component and expected revision required')
  if(!/^[a-f0-9]{64}$/.test(operationHash||'')||JSON.stringify(result).length>256*1024)throw Error('bounded sidecar operation identity/result required')
  const next=inspect(component,body),requestHash=hash({component,expected,bodyHash:next.fileHash,operationHash,resultHash:hash(result)})
  return lease.fenced(holder,term,db=>{
   if(db.prepare('SELECT home FROM tide_head').get().home!==holder)throw Error('sidecar source is standby')
   const prior=db.prepare('SELECT * FROM tide_sidecar_log WHERE op=?').get(op)
   if(prior){if(prior.request_hash!==requestHash||prior.holder!==holder)throw Error('sidecar operation conflict');return {op,requestHash,component,revision:prior.revision,digest:prior.digest,fileHash:prior.file_hash,replayed:true}}
   assertMemoryWritesOpen(db)
   const old=db.prepare('SELECT * FROM tide_sidecar_states WHERE component=?').get(component)
   if(old.revision!==expected.revision||old.digest!==expected.digest||old.file_hash!==expected.fileHash||next.baseline!==old.baseline||next.revision<=old.revision)throw Error('sidecar revision conflict')
   if(component==='aiMemory'&&!Buffer.from(body).subarray(0,Buffer.byteLength(old.body)).equals(Buffer.from(old.body)))throw Error('AI accepted history is append-only')
   if(component==='persona'){const a=JSON.parse(old.body).versions,b=JSON.parse(body).versions;if(JSON.stringify(b.slice(0,a.length))!==JSON.stringify(a))throw Error('persona accepted history cannot be rewritten')}
   db.prepare('INSERT INTO tide_sidecar_log(op,request_hash,component,holder,term,previous_revision,previous_digest,revision,digest,file_hash,body,operation_hash,result) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(op,requestHash,component,holder,term,old.revision,old.digest,next.revision,next.digest,next.fileHash,body,operationHash,JSON.stringify(result))
   db.prepare('UPDATE tide_sidecar_states SET revision=?,digest=?,file_hash=?,body=? WHERE component=?').run(next.revision,next.digest,next.fileHash,body,component)
   return {op,requestHash,component,revision:next.revision,digest:next.digest,fileHash:next.fileHash,replayed:false}
  })
 }
 function composite(){const db=lease.openAuthority();try{db.exec('BEGIN');const h=db.prepare('SELECT * FROM tide_head').get(),rows=Object.fromEntries(db.prepare('SELECT * FROM tide_sidecar_states').all().map(r=>[r.component,r])),before=replica.replicaHead(sqlCache)
  const entries=db.prepare('SELECT * FROM tide_log WHERE revision>? AND revision<=? ORDER BY revision').all(before.revision,h.revision).map(r=>({...r,mutation:JSON.parse(r.payload)}));replica.materialize(sqlCache,entries,{expected:before,sourceHead:h,home:h.home,switching:true})
  const head=createCompositeHead({sqlite:replica.replicaHead(sqlCache),jsonMemory:{overlayRevision:rows.json.revision,overlayHash:rows.json.digest,baselineSha256:rows.json.baseline},persona:{overlayVersion:rows.persona.revision,currentHash:rows.persona.digest,sha256:rows.persona.baseline},aiMemory:{revision:rows.aiMemory.revision,hash:rows.aiMemory.digest,baseline:rows.aiMemory.baseline}});db.exec('COMMIT');return head
 }finally{db.close()}}
 return {current,status,commit,composite,inspect}
}
