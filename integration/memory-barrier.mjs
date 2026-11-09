// Memory-write barrier in the existing authority DB. Does not pause QQ admission or activate a home.
import {assertCompositeAgreement} from './composite-head.mjs'
export function assertMemoryWritesOpen(db){const table=db.prepare("SELECT name FROM sqlite_master WHERE name='tide_memory_barrier'").get();if(table&&db.prepare('SELECT state FROM tide_memory_barrier WHERE id=1').get()?.state!=='open')throw Error('memory writes stopped for handover')}
export function createMemoryBarrier({lease,holder,term}){
 const tx=fn=>lease.fenced(holder,term,db=>{if(db.prepare('SELECT home FROM tide_head').get().home!==holder)throw Error('barrier source is not primary');return fn(db)})
 const valid=op=>{if(typeof op!=='string'||!op||op.length>160)throw Error('bounded barrier operation required')}
 function begin(op){valid(op);return tx(db=>{const old=db.prepare('SELECT * FROM tide_memory_barrier_ops WHERE op=?').get(op);if(old){if(old.holder!==holder||old.term!==term)throw Error('barrier operation conflict');return {op,state:old.state,replayed:true}}
  if(db.prepare('SELECT state FROM tide_memory_barrier WHERE id=1').get().state!=='open')throw Error('another memory barrier requires recovery')
  db.prepare("INSERT INTO tide_memory_barrier_ops VALUES(?,?,?,'blocked',NULL)").run(op,holder,term);db.prepare("UPDATE tide_memory_barrier SET state='blocked',op=?,holder=?,term=?,head=NULL WHERE id=1").run(op,holder,term);return {op,state:'blocked',replayed:false}
 })}
 function seal(op,readComposite){valid(op);if(typeof readComposite!=='function')throw Error('live four-store reader required');return tx(db=>{
  const row=db.prepare('SELECT * FROM tide_memory_barrier WHERE id=1').get();if(row.op!==op||row.holder!==holder||row.term!==term||!['blocked','sealed'].includes(row.state))throw Error('active memory barrier required')
  const head=readComposite(),s=head?.sqlite,ack={revision:s?.revision,hash:s?.hash,data_hash:s?.dataHash,baseline_hash:s?.baseline,protected_hash:s?.protectedHash,composite:head};assertCompositeAgreement(ack,ack,{required:true})
  const current=db.prepare('SELECT * FROM tide_head').get();if(current.revision!==s.revision||current.hash!==s.hash||current.baseline_hash!==s.baseline||current.protected_hash!==s.protectedHash)throw Error('source SQLite frontier differs')
  if(row.state==='sealed'){if(JSON.parse(row.head).digest!==head.digest)throw Error('sealed memory frontier changed; stop');return {op,state:'sealed',head,replayed:true}}
  const raw=JSON.stringify(head);db.prepare("UPDATE tide_memory_barrier SET state='sealed',head=? WHERE id=1").run(raw);db.prepare("UPDATE tide_memory_barrier_ops SET state='sealed',head=? WHERE op=?").run(raw,op);return {op,state:'sealed',head,replayed:false}
 })}
 function resume(op){valid(op);return tx(db=>{const old=db.prepare('SELECT * FROM tide_memory_barrier_ops WHERE op=?').get(op);if(!old||old.holder!==holder||old.term!==term)throw Error('owned barrier operation required');if(old.state==='aborted')return {op,state:'open',replayed:true};const current=db.prepare('SELECT * FROM tide_memory_barrier WHERE id=1').get();if(current.op!==op||current.term!==term)throw Error('barrier changed; do not resume');db.prepare("UPDATE tide_memory_barrier SET state='open',op=NULL,holder=NULL,term=NULL,head=NULL WHERE id=1").run();db.prepare("UPDATE tide_memory_barrier_ops SET state='aborted' WHERE op=?").run(op);return {op,state:'open',replayed:false}})}
 return Object.freeze({begin,seal,resume,status(){const db=lease.openAuthority();try{return {...db.prepare('SELECT * FROM tide_memory_barrier WHERE id=1').get()}}finally{db.close()}}})
}

export function consumeSealedMemoryBarrier(db,{op,holder,term,headDigest}){
 const row=db.prepare('SELECT * FROM tide_memory_barrier WHERE id=1').get()
 if(row.state!=='sealed'||row.op!==op||row.holder!==holder||row.term!==term||JSON.parse(row.head).digest!==headDigest)throw Error('matching sealed four-store memory frontier required')
 db.prepare("UPDATE tide_memory_barrier_ops SET state='transferred' WHERE op=?").run(op)
 db.prepare("UPDATE tide_memory_barrier SET state='open',op=NULL,holder=NULL,term=NULL,head=NULL WHERE id=1").run()
}
