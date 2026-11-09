import {applyStoreBatch} from '../../../integration/store-batch.mjs'
// Same memories/persona/FTS schema; this library ONLY materializes committed ops.
// It is not a new memory engine, search API or lease implementation.
import {DatabaseSync} from 'node:sqlite'
import {resolve,relative,isAbsolute,dirname} from 'node:path'
import {existsSync,realpathSync} from 'node:fs'
import {hash} from './tide-gateway.mjs'
export function checkedPath(file,root=process.env.TIDEMIND_SANDBOX_ROOT) {
 if(!root)throw new Error('isolated root required')
 const canonical=existsSync(file)?realpathSync(file):resolve(realpathSync(dirname(file)),file.split(/[\\/]/).pop())
 const rel=relative(realpathSync(root),canonical)
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('outside isolated root')
 for(const protectedRoot of ['<MEMORY_LAYERS_DIR>','C:/Users/USERNAME/.dsh/memory-layers','C:/Users/USERNAME/Aurabot/qq-chats/tidemind-shadow','<MEMORY_LAYERS_DIR_2>']) {
  const p=relative(resolve(protectedRoot),canonical)
  if(!p||(!p.startsWith('..')&&!isAbsolute(p)))throw new Error('production/shadow write prohibited')
 }
 return canonical
}
function rows(db,table) {
 const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)
 return exists?db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all():[]
}
export const dataHash=db=>hash(['memories','persona','persona_versions'].map(t=>[t,rows(db,t)]))
const protectedHash=db=>hash([rows(db,'memories').filter(r=>r.layer==='core'),rows(db,'persona'),rows(db,'persona_versions')])
export function initializeReplica(file) {
 const db=new DatabaseSync(checkedPath(file))
 try {
  if(!db.prepare("SELECT name FROM sqlite_master WHERE name='memories'").get())throw new Error('existing memory-layers schema required')
  db.exec(`CREATE TABLE IF NOT EXISTS tidemind_replica(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,hash TEXT NOT NULL,data_hash TEXT NOT NULL,protected_hash TEXT NOT NULL,baseline_hash TEXT NOT NULL)`)
  db.prepare('INSERT OR IGNORE INTO tidemind_replica VALUES(1,0,?,?,?,?)').run('GENESIS',dataHash(db),protectedHash(db),dataHash(db))
 }finally{db.close()}
}
export function replicaHead(file) {
 const db=new DatabaseSync(checkedPath(file),{readOnly:true})
 try{const head={...db.prepare('SELECT revision,hash,data_hash,protected_hash,baseline_hash FROM tidemind_replica').get()};if(dataHash(db)!==head.data_hash||protectedHash(db)!==head.protected_hash)throw new Error('replica changed outside journal');return head}finally{db.close()}
}
export function materialize(file,entries,{expected,sourceHead,home,switching=false}) {
 if(!['local','cloud'].includes(home))throw new Error('home required')
 if(home==='local'&&sourceHead.home==='cloud'&&!switching)throw new Error('reverse requires handover')
 const db=new DatabaseSync(checkedPath(file))
 try {
  db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE')
  const current=db.prepare('SELECT * FROM tidemind_replica').get()
  if(current.baseline_hash!==sourceHead.baseline_hash||current.protected_hash!==sourceHead.protected_hash)throw new Error('replica baseline mismatch')
  if(current.revision!==expected.revision||current.hash!==expected.hash)throw new Error('target revision conflict')
  if(current.revision>sourceHead.revision)throw new Error('newer target must never be overwritten')
  if(dataHash(db)!==current.data_hash||protectedHash(db)!==current.protected_hash)throw new Error('out-of-band mutation')
  let revision=current.revision,entryHash=current.hash
  for(const entry of entries) {
   // Replayed committed prefix is harmless; same-number divergence is rejected
   // by source/target head checks below and by the contiguous new-entry chain.
   if(entry.revision<=revision)continue
   const mutation=entry.mutation||JSON.parse(entry.payload)
   if(entry.revision!==revision+1||entry.parent!==entryHash)throw new Error('journal gap or branch')
   const computed=hash({revision:entry.revision,parent:entry.parent,op:entry.op,holder:entry.holder,term:entry.term,mutation})
   if(computed!==entry.hash)throw new Error('journal hash mismatch')
   if(mutation.format==='original-store-session-v1'){
    applyStoreBatch(db,mutation);revision=entry.revision;entryHash=entry.hash;continue
   }
   const previous=db.prepare('SELECT * FROM memories WHERE id=?').get(mutation.id)
   if(previous?.layer==='core'||mutation.fields.layer==='core')throw new Error('core protected')
   const columns=new Set(db.prepare('PRAGMA table_info(memories)').all().map(r=>r.name))
   let values={...mutation.fields}
   if(!previous)values={layer:'episodic',category:'fact',tags:'[]',importance:3,confidence:1,status:'active',source:'tool',meta:'{}',...values,id:mutation.id}
   if(!previous&&['content','created_at','updated_at','norm_hash'].some(k=>values[k]===undefined))throw new Error('original store insert fields required')
   const fields=Object.keys(values)
   if(fields.some(k=>!columns.has(k)))throw new Error('schema mismatch')
   // Column names were whitelisted at authoritative acceptance; recheck here.
   if(fields.some(k=>!/^[a-z_]+$/.test(k)))throw new Error('invalid column')
   if(previous)db.prepare('UPDATE memories SET '+fields.map(k=>k+'=?').join(',')+' WHERE id=?').run(...fields.map(k=>values[k]),mutation.id)
   else db.prepare('INSERT INTO memories ('+fields.join(',')+') VALUES ('+fields.map(()=>'?').join(',')+')').run(...fields.map(k=>values[k]))
   revision=entry.revision;entryHash=entry.hash
  }
  if(revision!==sourceHead.revision||entryHash!==sourceHead.hash)throw new Error('source moved or incomplete journal')
  if(protectedHash(db)!==current.protected_hash)throw new Error('identity changed')
  db.prepare('UPDATE tidemind_replica SET revision=?,hash=?,data_hash=? WHERE id=1').run(revision,entryHash,dataHash(db))
  db.exec('COMMIT');return replicaHead(file)
 }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
 finally{db.close()}
}
