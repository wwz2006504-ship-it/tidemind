import {assertMemoryWritesOpen} from './memory-barrier.mjs'
// Pause BEFORE module/Hub dispatch. Deferred raw events stay private in the existing authority DB.
import {createHash} from 'node:crypto'
const sha=s=>createHash('sha256').update(s).digest('hex')
export const sourceEventHash=event=>sha(JSON.stringify(event))
export function createSourceAdmission({lease,holder,term}){
 const active=new Set(),tx=fn=>lease.fenced(holder,term,db=>{if(db.prepare('SELECT home FROM tide_head').get().home!==holder)throw Error('source admission is not primary');return fn(db)})
 const metadata=lease.openAuthority();try{metadata.exec('CREATE TABLE IF NOT EXISTS tide_source_callbacks(op TEXT PRIMARY KEY,event_hash TEXT NOT NULL,holder TEXT NOT NULL,term INTEGER NOT NULL,state TEXT NOT NULL)')}finally{metadata.close()}
 const remote=new Map()
 const valid=op=>{if(typeof op!=='string'||!op||op.length>160)throw Error('bounded pause operation required')}
 function pause(op){valid(op);return tx(db=>{const r=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get();if(r.op===op){if(r.holder!==holder||r.term!==term)throw Error('pause operation conflict');return {op,state:r.state,replayed:true}}if(r.state!=='open')throw Error('source gate already paused');db.prepare("UPDATE tide_source_gate SET state='paused',op=?,holder=?,term=? WHERE id=1").run(op,holder,term);return {op,state:'paused',replayed:false}})}
 function capture(event){return tx(db=>{const r=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get();if(r.state==='open'){db.prepare('UPDATE tide_source_gate SET active=active+1 WHERE id=1').run();return false};if(r.holder!==holder||r.term!==term)throw Error('old source pause requires recovery');if(event?.post_type==='meta_event'&&event.meta_event_type==='heartbeat')return {paused:true,transportOnly:true};const raw=JSON.stringify(event);if(!raw||Buffer.byteLength(raw)>65536)throw Error('deferred event too large');const id=sha(raw),old=db.prepare('SELECT id FROM tide_source_deferred WHERE id=?').get(id);if(!old)db.prepare("INSERT INTO tide_source_deferred VALUES(?,?,?,'pending',?,(SELECT coalesce(max(sequence),0)+1 FROM tide_source_deferred))").run(id,raw,Date.now()+86400000,r.op);return {deferred:true,id,duplicate:!!old}})}
 async function dispatch(event,fn){if(typeof fn!=='function')throw Error('original dispatch callback required');const saved=capture(event);if(saved)return saved;const token={};active.add(token);try{return await fn()}finally{try{tx(db=>{if(db.prepare('SELECT active FROM tide_source_gate WHERE id=1').get().active<1)throw Error('source admission counter changed');db.prepare('UPDATE tide_source_gate SET active=active-1 WHERE id=1').run()})}finally{active.delete(token)}}}
 function beginRemote(op,event){valid(op);const raw=JSON.stringify(event);if(!raw||Buffer.byteLength(raw)>65536)throw Error('bounded original event required');const eventHash=sha(raw)
  const result=tx(db=>{const prior=db.prepare('SELECT * FROM tide_source_callbacks WHERE op=?').get(op);if(prior){if(prior.event_hash!==eventHash)throw Error('source callback operation conflict');return {op,eventHash,admitted:false,replayed:true,state:prior.state}}
   const saved=capture(event),state=saved?'deferred':'active';db.prepare('INSERT INTO tide_source_callbacks VALUES(?,?,?,?,?)').run(op,eventHash,holder,term,state);return saved?{op,eventHash,admitted:false,...saved}:{op,eventHash,admitted:true,state}
  });if(result.admitted){const token={};remote.set(op,token);active.add(token)}return result
 }
 function callbackStatus(op){valid(op);return tx(db=>{const row=db.prepare('SELECT * FROM tide_source_callbacks WHERE op=?').get(op);if(!row)throw Error('source callback not found');return {...row}})}
 function finishRemote(op,eventHash,success){valid(op);if(typeof success!=='boolean')throw Error('explicit callback completion required');const state=success?'done':'review'
  const result=tx(db=>{const row=db.prepare('SELECT * FROM tide_source_callbacks WHERE op=?').get(op);if(!row||row.event_hash!==eventHash||row.holder!==holder||row.term!==term)throw Error('source callback completion differs');if(row.state===state)return {op,state,replayed:true};if(row.state!=='active')throw Error('uncertain callback cannot change outcome');if(db.prepare('SELECT active FROM tide_source_gate WHERE id=1').get().active<1)throw Error('source active counter differs');db.prepare('UPDATE tide_source_callbacks SET state=? WHERE op=?').run(state,op);db.prepare('UPDATE tide_source_gate SET active=active-1 WHERE id=1').run();return {op,state,replayed:false}})
  const token=remote.get(op);if(token){active.delete(token);remote.delete(op)}return result
 }
 function resume(op){valid(op);return tx(db=>{assertMemoryWritesOpen(db);if(db.prepare("SELECT count(*) n FROM tide_source_callbacks WHERE state='review'").get().n)throw Error('source callback needs replay or review before resume');const r=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get();if(r.op!==op||r.holder!==holder||r.term!==term)throw Error('owned source pause required');if(db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state IN ('pending','expired','dispatching','needs_review')").get().n)throw Error('deferred input needs replay or review before resume');db.prepare("UPDATE tide_source_gate SET state='open' WHERE id=1").run();return {op,state:'open'}})}
 function status(){return tx(db=>({...db.prepare('SELECT state,op,holder,term,active AS durableActive FROM tide_source_gate WHERE id=1').get(),active:active.size,pending:db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state='pending'").get().n,uncertain:db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state IN ('dispatching','needs_review')").get().n+db.prepare("SELECT count(*) n FROM tide_source_callbacks WHERE state='review' AND op NOT LIKE 'replay:%'").get().n,expired:db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state='expired'").get().n}))}
 async function drain({timeoutMs=30000,signal}={}){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw Error('bounded source drain timeout required');const until=performance.now()+timeoutMs;while(active.size){signal?.throwIfAborted();if(performance.now()>=until)throw Error('source callback drain timed out; pause retained');await new Promise(resolve=>setTimeout(resolve,5))}const current=status();if(current.durableActive!==0)throw Error('unknown source callback remains; recovery required');return current}
 function purgeExpired(){return tx(db=>({purged:db.prepare("UPDATE tide_source_deferred SET event_json=NULL,state='expired' WHERE state='pending' AND expires_at<=?").run(Date.now()).changes}))}
 function claimDeferred(op){valid(op);return tx(db=>{assertMemoryWritesOpen(db);if(db.prepare("SELECT count(*) n FROM tide_source_callbacks WHERE state='review'").get().n)throw Error('uncertain source callback requires review');const gate=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get();if(gate.state!=='paused'||gate.op!==op||gate.holder!==holder||gate.term!==term||gate.active!==0)throw Error('exclusive paused source required')
    if(db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state IN ('dispatching','needs_review','expired')").get().n)throw Error('uncertain deferred input requires review, not automatic replay')
    const row=db.prepare("SELECT * FROM tide_source_deferred WHERE state='pending' ORDER BY sequence LIMIT 1").get();if(!row)return null
    if(row.expires_at<=Date.now()||!row.event_json)throw Error('expired deferred input cannot replay')
    const raw=JSON.parse(row.event_json);if(sha(row.event_json)!==row.id)throw Error('deferred event content changed')
    db.prepare("UPDATE tide_source_deferred SET state='dispatching' WHERE id=?").run(row.id);db.prepare('UPDATE tide_source_gate SET active=active+1 WHERE id=1').run();const callbackOp='replay:'+row.id;db.prepare("INSERT INTO tide_source_callbacks VALUES(?,?,?,?,'active')").run(callbackOp,row.id,holder,term);return {id:row.id,raw,callbackOp}
   })}
 function finishDeferred(op,id,success){valid(op);if(typeof success!=='boolean')throw Error('explicit deferred outcome required');return tx(db=>{
  const gate=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get(),row=db.prepare('SELECT * FROM tide_source_deferred WHERE id=?').get(id),callback=db.prepare('SELECT * FROM tide_source_callbacks WHERE op=?').get('replay:'+id),state=success?'forwarded':'needs_review'
  if(gate.op!==op||gate.state!=='paused'||gate.holder!==holder||gate.term!==term||!row||!callback||callback.holder!==holder||callback.term!==term)throw Error('owned deferred callback required')
  if(row.state===state)return {id,state,replayed:true}
  if(row.state!=='dispatching'||callback.state!=='active'||gate.active<1)throw Error('deferred callback already uncertain or completed')
  db.prepare('UPDATE tide_source_deferred SET state=? WHERE id=?').run(state,id);db.prepare('UPDATE tide_source_callbacks SET state=? WHERE op=?').run(success?'done':'review','replay:'+id);db.prepare('UPDATE tide_source_gate SET active=active-1 WHERE id=1').run();return {id,state,replayed:false}
 })}
 async function replay(op,originalDispatch,{limit=32}={}){
  valid(op);if(typeof originalDispatch!=='function'||!Number.isSafeInteger(limit)||limit<1||limit>64)throw Error('bounded original replay callback required')
  let forwarded=0
  for(let i=0;i<limit;i++){
   const event=claimDeferred(op)
   if(!event)break
   const token={};active.add(token)
   try{await originalDispatch(event.raw);finishDeferred(op,event.id,true);forwarded++}
   catch(error){try{finishDeferred(op,event.id,false)}catch{};throw Error('deferred dispatch uncertain; automatic replay stopped',{cause:error})}
   finally{active.delete(token)}
  }
  return {forwarded,...status()}
 }
 return Object.freeze({pause,dispatch,beginRemote,finishRemote,callbackStatus,resume,status,drain,purgeExpired,claimDeferred,finishDeferred,replay})
}

export function consumePausedSourceAdmission(db,{op,holder,term}){
 const row=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get()
 if(row.active!==0)throw Error('source callbacks not drained')
 if(db.prepare("SELECT name FROM sqlite_master WHERE name='tide_source_callbacks'").get()&&db.prepare("SELECT count(*) n FROM tide_source_callbacks WHERE state='review'").get().n)throw Error('source callback requires review')
 if(row.state!=='paused'||row.op!==op||row.holder!==holder||row.term!==term)throw Error('matching paused source admission required')
 if(db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state IN ('pending','expired','dispatching','needs_review')").get().n)throw Error('deferred source input must be recovered before handover')
 db.prepare("UPDATE tide_source_gate SET state='open' WHERE id=1").run()
}

export function sourceAutonomyAllowed(db){if(!db.prepare("SELECT name FROM sqlite_master WHERE name='tide_source_gate'").get())return true;return db.prepare('SELECT state FROM tide_source_gate WHERE id=1').get()?.state==='open'}
