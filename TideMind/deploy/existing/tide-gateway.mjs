import {consumePausedSourceAdmission} from '../../../integration/source-admission.mjs'
import {assertMemoryWritesOpen,consumeSealedMemoryBarrier} from '../../../integration/memory-barrier.mjs'
import {consumeHandoverTicket} from '../../../integration/sync-receipts.mjs'
import {assertCompositeAgreement,assertCompositeTakeover} from '../../../integration/composite-head.mjs'
import {denyCognitiveSideEffect} from '../../../integration/activity-gate.mjs'
import {assertHistoryAckAgreement} from '../../../integration/session-history-authority.mjs'
import {verifyBatch} from '../../../integration/store-batch.mjs'
// Library extending the original lease authority. No second lease implementation.
import {createHash,randomUUID} from 'node:crypto'
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value
const canonical=value=>JSON.stringify(ordered(value))
const sha=value=>createHash('sha256').update(canonical(value)).digest('hex')
export const hash=sha
// An HTTP/tool timeout is not evidence that the external action did not happen.
// Keep both planned transfer and failover stopped until its original record resolves.
function assertToolOutcomesResolved(db){
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tide_tool_permits'").get()&&db.prepare("SELECT count(*) n FROM tide_tool_permits WHERE state IN ('executing','attempted','unknown')").get().n)throw Error('unresolved tool outcomes must be reviewed')
}
export function initialize(lease, {protectedIds,baseline}={}) {
 if(!baseline?.data_hash||!baseline?.protected_hash)throw new Error("baseline fingerprints required")
 if(!Array.isArray(protectedIds))throw new Error("protected baseline required")
 const db=lease.openAuthority()
 try {db.exec(`
 CREATE TABLE IF NOT EXISTS tide_source_gate(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,op TEXT,holder TEXT,term INTEGER,active INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS tide_transfer_custody(term INTEGER NOT NULL,op TEXT NOT NULL,holder TEXT NOT NULL,deadline INTEGER NOT NULL,PRIMARY KEY(term,op));
 INSERT OR IGNORE INTO tide_source_gate(id,state,op,holder,term) VALUES(1,'open',NULL,NULL,NULL);
 CREATE TABLE IF NOT EXISTS tide_source_deferred(id TEXT PRIMARY KEY,event_json TEXT,expires_at INTEGER NOT NULL,state TEXT NOT NULL,pause_op TEXT NOT NULL,sequence INTEGER UNIQUE);
 CREATE TABLE IF NOT EXISTS tide_memory_barrier(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,op TEXT,holder TEXT,term INTEGER,head TEXT);
 INSERT OR IGNORE INTO tide_memory_barrier VALUES(1,'open',NULL,NULL,NULL,NULL);
 CREATE TABLE IF NOT EXISTS tide_memory_barrier_ops(op TEXT PRIMARY KEY,holder TEXT NOT NULL,term INTEGER NOT NULL,state TEXT NOT NULL,head TEXT);
 CREATE TABLE IF NOT EXISTS tide_sync_receipts(op TEXT PRIMARY KEY,signature TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tide_sync_signatures(op TEXT PRIMARY KEY,signature TEXT NOT NULL,body_digest TEXT NOT NULL,holder TEXT NOT NULL,term INTEGER NOT NULL,target TEXT NOT NULL,base_digest TEXT NOT NULL,head_digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tide_transfer_tickets(op TEXT PRIMARY KEY,signature TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,receipt_op TEXT,receipt_hash TEXT);
 CREATE TABLE IF NOT EXISTS tide_identity(id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS tide_head(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,hash TEXT NOT NULL,home TEXT NOT NULL,baseline_hash TEXT NOT NULL,protected_hash TEXT NOT NULL);

 CREATE TABLE IF NOT EXISTS tide_log(revision INTEGER PRIMARY KEY,op TEXT UNIQUE NOT NULL,term INTEGER NOT NULL,holder TEXT NOT NULL,parent TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tide_outbox(event_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,holder TEXT NOT NULL,term INTEGER NOT NULL,state TEXT NOT NULL,attempt TEXT,receipt TEXT);
 CREATE TABLE IF NOT EXISTS tide_handover(op TEXT PRIMARY KEY,signature TEXT NOT NULL,result TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tide_history_head(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,digest TEXT NOT NULL,baseline TEXT NOT NULL,body TEXT NOT NULL,four_digest TEXT NOT NULL,holder TEXT NOT NULL,term INTEGER NOT NULL,pause_op TEXT NOT NULL,request_hash TEXT NOT NULL);
 `)
 db.prepare("INSERT OR IGNORE INTO tide_head VALUES(1,0,'GENESIS','local',?,?)").run(baseline.data_hash,baseline.protected_hash)
 const anchor=db.prepare('SELECT baseline_hash,protected_hash FROM tide_head').get()
 if(anchor.baseline_hash!==baseline.data_hash||anchor.protected_hash!==baseline.protected_hash)throw new Error('baseline changed')
 if(!db.prepare('PRAGMA table_info(tide_source_deferred)').all().some(r=>r.name==='sequence'))db.exec('ALTER TABLE tide_source_deferred ADD COLUMN sequence INTEGER')
 db.exec('UPDATE tide_source_deferred SET sequence=rowid WHERE sequence IS NULL')
 if(!db.prepare('PRAGMA table_info(tide_source_gate)').all().some(r=>r.name==='active'))db.exec('ALTER TABLE tide_source_gate ADD COLUMN active INTEGER NOT NULL DEFAULT 0')
 const prior=db.prepare("SELECT id FROM tide_identity ORDER BY id").all().map(r=>r.id)
 const desired=[...new Set(protectedIds)].sort()
 if(prior.length&&JSON.stringify(prior)!==JSON.stringify(desired))throw new Error("protected baseline changed")
 const insert=db.prepare("INSERT OR IGNORE INTO tide_identity VALUES(?)")
 for(const id of desired)insert.run(id)
 }finally{db.close()}
}
export function head(lease) {
 const db=lease.openAuthority();try{return {...db.prepare('SELECT revision,hash,home,baseline_hash,protected_hash FROM tide_head WHERE id=1').get()}}finally{db.close()}
}
export function commit(lease,holder,term,{op,expectedRevision,expectedHash,mutation}) {
 denyCognitiveSideEffect()
 if(typeof op!=='string'||!op||op.length>200)throw new Error('invalid operation')
 validateMutation(mutation)
 return lease.fenced(holder,term,db=>{
  if((mutation.touched||[mutation.id]).some(id=>db.prepare('SELECT id FROM tide_identity WHERE id=?').get(id)))throw new Error('protected core record')
  const existing=db.prepare('SELECT * FROM tide_log WHERE op=?').get(op)
  if(existing){if(existing.payload!==canonical(mutation))throw new Error('operation conflict');return {revision:existing.revision,hash:existing.hash,replayed:true}}
  assertMemoryWritesOpen(db)
  if(mutation.format==='original-store-session-v1'){const c=mutation.commitContext;if(!c||c.op!==op||c.holder!==holder||c.term!==term||c.revision!==expectedRevision||c.hash!==expectedHash)throw new Error('store proof bound to another commit')}
  const h=db.prepare('SELECT * FROM tide_head WHERE id=1').get()
  if(h.home!==holder)throw new Error('standby is read-only')
  if(h.revision!==expectedRevision||h.hash!==expectedHash)throw new Error('revision conflict')
  const revision=h.revision+1,payload=canonical(mutation)
  const entryHash=sha({revision,parent:h.hash,op,holder,term,mutation})
  db.prepare('INSERT INTO tide_log VALUES(?,?,?,?,?,?,?)').run(revision,op,term,holder,h.hash,entryHash,payload)
  db.prepare('UPDATE tide_head SET revision=?,hash=? WHERE id=1').run(revision,entryHash)
  return {revision,hash:entryHash,replayed:false}
 })
}
export function committedSince(lease,revision=0) {
 const db=lease.openAuthority()
 try{return db.prepare('SELECT * FROM tide_log WHERE revision>? ORDER BY revision').all(revision).map(r=>({...r,mutation:JSON.parse(r.payload)}))}
 finally{db.close()}
}
export function handover(lease,holder,term,{op,target,expectedRevision,expectedHash,sourceAck,targetAck,ticketId}) {
 if(!['local','cloud'].includes(target)||target===holder)throw new Error('invalid target')
 const signature=sha({holder,term,op,target,expectedRevision,expectedHash,sourceAck,targetAck,ticketId})
 return lease.fenced(holder,term,db=>{
  const prior=db.prepare('SELECT * FROM tide_handover WHERE op=?').get(op)
  if(prior){if(prior.signature!==signature)throw new Error('handover conflict');return JSON.parse(prior.result)}
  const h=db.prepare('SELECT * FROM tide_head WHERE id=1').get()
  if(h.home!==holder||h.revision!==expectedRevision||h.hash!==expectedHash)throw new Error('revision conflict')
  for(const ack of [sourceAck,targetAck])if(!ack||ack.revision!==h.revision||ack.hash!==h.hash||ack.baseline_hash!==h.baseline_hash||ack.protected_hash!==h.protected_hash)throw new Error('replica not synchronized')
  if(!sourceAck.data_hash||sourceAck.data_hash!==targetAck.data_hash||sourceAck.protected_hash!==targetAck.protected_hash)throw new Error('replica data mismatch')
  assertCompositeAgreement(sourceAck,targetAck,{required:process.env.TIDEMIND_REQUIRE_COMPOSITE_HANDOVER==='1'})
  assertToolOutcomesResolved(db)
  assertHistoryAckAgreement(db,{sourceAck,targetAck,holder,term,op})
  if(process.env.TIDEMIND_REQUIRE_HANDOVER_TICKET==='1'||ticketId)consumeHandoverTicket(db,{ticketId,op,holder,term,target,sourceAck,targetAck})
  if(db.prepare("SELECT count(*) n FROM tide_outbox WHERE state IN ('pending','unknown')").get().n)throw new Error('unresolved outgoing events')
  const memoryBarrier=db.prepare('SELECT state FROM tide_memory_barrier WHERE id=1').get()
  if(process.env.TIDEMIND_REQUIRE_MEMORY_BARRIER==='1'||memoryBarrier.state!=='open')consumeSealedMemoryBarrier(db,{op,holder,term,headDigest:sourceAck?.composite?.digest})
  const sourceGate=db.prepare('SELECT state FROM tide_source_gate WHERE id=1').get()
  if(process.env.TIDEMIND_REQUIRE_SOURCE_GATE==='1'||sourceGate.state!=='open')consumePausedSourceAdmission(db,{op,holder,term})
  const result={ok:true,target,revision:h.revision,hash:h.hash}
  db.prepare('UPDATE tide_head SET home=? WHERE id=1').run(target)
  // Release occurs in the SAME transaction. Target must acquire a NEW term.
  db.prepare('UPDATE lease SET holder=NULL,expires_at=0,updated_at=? WHERE id=1').run(Date.now())
  db.prepare('INSERT INTO tide_handover VALUES(?,?,?)').run(op,signature,JSON.stringify(result))
  return result
 },{allowReleased:true})
}
export function enqueue(lease,holder,term,args) {
 if(process.env.TIDEMIND_REQUIRE_QQ_BINDING==='1')throw new Error('trusted inbound/turn binding required')
 return lease.fenced(holder,term,db=>enqueueInTransaction(db,holder,term,args))
}
// Trusted adapters may compose ingress binding and the EXISTING outbox atomically.
export function enqueueInTransaction(db,holder,term,{channel,eventId,slot='reply',payload}) {
 denyCognitiveSideEffect()
 if(slot!=='reply')throw new Error('one stable reply slot per event')
 if(typeof channel!=='string'||typeof eventId!=='string'||!channel||!eventId||typeof payload!=='string'||payload.length>16000)throw new Error('invalid event')
 const key=sha([channel,eventId,slot]),payloadHash=sha(payload)
 const h=db.prepare('SELECT home FROM tide_head').get()
 if(h.home!==holder)throw new Error('standby is read-only')
 const row=db.prepare('SELECT * FROM tide_outbox WHERE event_key=?').get(key)
 if(row){if(row.payload_hash!==payloadHash)throw new Error('event payload conflict');return {key,state:row.state,replayed:true}}
 db.prepare("INSERT INTO tide_outbox VALUES(?,?,?,?,?,'pending',NULL,NULL)").run(key,payloadHash,payload,holder,term)
 return {key,state:'pending',replayed:false}
}
// ONLY the trusted gateway process invokes the transport; clients never get QQ credentials.
export async function dispatch(lease,holder,term,key,transport) {
 denyCognitiveSideEffect()
 const claim=lease.fenced(holder,term,db=>{
  const r=db.prepare('SELECT * FROM tide_outbox WHERE event_key=?').get(key)
  if(!r)throw new Error('event missing')
  if(sha(r.payload)!==r.payload_hash)throw new Error('outgoing payload changed')
  if(r.state!=='pending')return {skip:true,state:r.state}
  if(r.term!==term||r.holder!==holder)throw new Error('queued event belongs to previous term')
  const attempt=randomUUID()
  // Persist uncertainty BEFORE calling QQ. Crash/timeout never auto-retries.
  db.prepare("UPDATE tide_outbox SET state='unknown',attempt=? WHERE event_key=? AND state='pending'").run(attempt,key)
  return {attempt,payload:r.payload}
 })
 if(claim.skip)return {state:claim.state,attempted:false}
 let receipt
 try {receipt=await transport({eventKey:key,payload:claim.payload})}catch{return {state:'unknown',attempted:true}}
 if(!receipt||typeof receipt.id!=='string')return {state:'unknown',attempted:true}
 const db=lease.openAuthority()
 try {db.prepare("UPDATE tide_outbox SET state='sent',receipt=? WHERE event_key=? AND attempt=? AND state='unknown'").run(receipt.id,key,claim.attempt)}finally{db.close()}
 return {state:'sent',attempted:true}
}
export function validateMutation(m) {
 if(m?.format==='original-store-session-v1'){verifyBatch(m);return}
 if(process.env.TIDEMIND_REQUIRE_STORE_PROOF==='1')throw new Error('trusted original-store proof required')
 if(!m||typeof m.id!=='string'||!m.id||!m.fields||typeof m.fields!=='object'||Array.isArray(m.fields))throw new Error('invalid mutation')
 const allowed=new Set(['content','tags','status','valid_to','superseded_by','updated_at','layer','category','importance','confidence','source','created_at','norm_hash','meta'])
 if(Object.keys(m.fields).some(k=>!allowed.has(k)))throw new Error('unsupported field')
 if(m.fields.layer==='core'||m.id.toLowerCase().startsWith('persona'))throw new Error('protected identity')
 if(m.fields.status!==undefined&&!['active','withdrawn','superseded','pending'].includes(m.fields.status))throw new Error('invalid status')
 if(m.id.length>128)throw new Error('oversize ID')
 const f=m.fields
 if(f.content!==undefined&&(typeof f.content!=='string'||!f.content.trim()||f.content.length>8000||typeof f.norm_hash!=='string'||!/^[a-f0-9]{32}$/.test(f.norm_hash)))throw new Error('original content/norm_hash required')
 if(f.tags!==undefined){const tags=JSON.parse(f.tags);if(!Array.isArray(tags)||tags.some(t=>typeof t!=='string'))throw new Error('invalid tags')}
 if(f.layer!==undefined&&!['episodic','semantic','working'].includes(f.layer))throw new Error('invalid layer')
 for(const k of ['created_at','updated_at','valid_to'])if(f[k]!==undefined&&f[k]!==null&&(!Number.isSafeInteger(f[k])||f[k]<0))throw new Error('invalid timestamp')
 if(f.confidence!==undefined&&(!Number.isFinite(f.confidence)||f.confidence<0||f.confidence>1))throw new Error('invalid confidence')
 if(f.importance!==undefined&&(!Number.isInteger(f.importance)||f.importance<1||f.importance>5))throw new Error('invalid importance')
 if(JSON.stringify(m).length>65536)throw new Error('oversize mutation')
}


// Trusted failover hook: called ONLY after the new holder acquired a new term,
// and its materializer has verified the acknowledged revision and data hash.
export function takeover(lease,holder,term,{expectedRevision,expectedHash,targetAck,expectedComposite}) {
 if(!['local','cloud'].includes(holder))throw new Error('invalid home')
 return lease.fenced(holder,term,db=>{
  const h=db.prepare('SELECT * FROM tide_head').get()
  if(h.revision!==expectedRevision||h.hash!==expectedHash||targetAck?.revision!==h.revision||targetAck?.hash!==h.hash||!targetAck?.data_hash||targetAck?.protected_hash!==h.protected_hash||targetAck?.baseline_hash!==h.baseline_hash)throw new Error('takeover replica not synchronized')
  if(process.env.TIDEMIND_REQUIRE_COMPOSITE_HANDOVER==='1'||targetAck?.composite||expectedComposite)assertCompositeTakeover(targetAck,expectedComposite)
  if(db.prepare("SELECT count(*) n FROM tide_outbox WHERE state='unknown'").get().n)throw new Error('unknown delivery must be reviewed')
  assertToolOutcomesResolved(db)
  assertHistoryAckAgreement(db,{sourceAck:targetAck,targetAck,holder,term,takeover:true})
  db.prepare('UPDATE tide_head SET home=? WHERE id=1').run(holder)
  // Pending means no QQ attempt ever began; adopting it cannot duplicate send.
  db.prepare("UPDATE tide_outbox SET holder=?,term=? WHERE state='pending'").run(holder,term)
  return {ok:true,home:holder,revision:h.revision,hash:h.hash}
 })
}
