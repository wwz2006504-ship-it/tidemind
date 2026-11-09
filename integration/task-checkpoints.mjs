import {sourceAutonomyAllowed} from './source-admission.mjs'
// Durable event-driven cognitive checkpoints in the EXISTING authority DB, not a memory engine.
import {randomUUID} from 'node:crypto'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {runCognitiveScope} from './activity-gate.mjs'
const phases=['observe','reflect','plan','verify'],groups=new Map()
const validateText=(s,max)=>{if(typeof s!=='string'||s.length>max)throw Error('bounded text required');return s}
export function createTaskCheckpoints({lease,holder='local',term,handlers,budget=20,toolPolicy='existing',taskOnly=false}){
 if(!['existing','read-only'].includes(toolPolicy))throw Error('unknown task tool policy')
 if(!Number.isSafeInteger(budget)||budget<1||!handlers||phases.some(p=>typeof handlers[p]!=='function')||Object.keys(handlers).some(p=>!phases.includes(p)))throw Error('cognitive handlers and finite budget required')
 const activeTerm=()=>typeof term==='function'?term():term,instance=randomUUID()
 const tx=fn=>lease.fenced(holder,activeTerm(),db=>{if(!taskOnly&&db.prepare('SELECT home FROM tide_head').get().home!==holder)throw Error('standby cannot schedule');return fn(db)})
 const key=tx(db=>{
  db.exec(`CREATE TABLE IF NOT EXISTS tide_task_control(id INTEGER PRIMARY KEY CHECK(id=1),rest INTEGER NOT NULL,generation INTEGER NOT NULL,revision INTEGER NOT NULL,spent INTEGER NOT NULL,budget INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS tide_tasks(id TEXT PRIMARY KEY,signature TEXT NOT NULL,input TEXT NOT NULL,units INTEGER NOT NULL,state TEXT NOT NULL,phase INTEGER NOT NULL,checkpoint TEXT NOT NULL,term INTEGER,attempt TEXT);
   CREATE TABLE IF NOT EXISTS tide_task_ops(op TEXT PRIMARY KEY,signature TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS tide_task_log(revision INTEGER PRIMARY KEY,task_id TEXT,event TEXT NOT NULL,digest TEXT NOT NULL);`)
  db.prepare('INSERT OR IGNORE INTO tide_task_control VALUES(1,1,0,0,0,?)').run(budget)
  if(db.prepare('SELECT budget FROM tide_task_control').get().budget!==budget)throw Error('persisted budget differs; explicit review required')
  const interrupted=db.prepare("SELECT id FROM tide_tasks WHERE state='running' AND term<?").all(activeTerm())
  for(const r of interrupted){db.prepare("UPDATE tide_tasks SET state='needs_review' WHERE id=?").run(r.id);record(db,r.id,'interrupted',r.id)}
  return db.prepare('PRAGMA database_list').all().find(r=>r.name==='main').file
 })
 const group=groups.get(key)||new Set();groups.set(key,group)
 let job=null,abort=null,disposed=false,wake=false
 const external=new Map()
 function control(db){return db.prepare('SELECT * FROM tide_task_control').get()}
 function record(db,id,event,value){const revision=control(db).revision+1;db.prepare('UPDATE tide_task_control SET revision=?').run(revision);db.prepare('INSERT INTO tide_task_log VALUES(?,?,?,?)').run(revision,id,event,hash(value));return revision}
 const status=()=>tx(db=>({control:{...control(db)},tasks:db.prepare('SELECT id,state,phase,checkpoint,term FROM tide_tasks ORDER BY id').all(),stopping:control(db).rest===1&&[...group].some(s=>s.active()),active:[...group].filter(s=>s.active()).length}))
 function activeGuard(task,generation,attempt){
  abort?.signal.throwIfAborted()
  if(disposed)throw Error('scheduler disposed')
  return tx(db=>{const c=control(db),r=db.prepare('SELECT state,attempt FROM tide_tasks WHERE id=?').get(task.id)
   if(c.rest||c.generation!==generation||r?.state!=='running'||r.attempt!==attempt)throw Error('task paused or fenced')
  })
 }
 async function drain(){
  while(!disposed){
   const claimed=tx(db=>{const c=control(db);if(c.rest||!sourceAutonomyAllowed(db))return null
    const task=db.prepare("SELECT * FROM tide_tasks WHERE state='queued' ORDER BY id LIMIT 1").get();if(!task)return null
    const attempt=randomUUID();db.prepare("UPDATE tide_tasks SET state='running',term=?,attempt=? WHERE id=?").run(activeTerm(),attempt,task.id);record(db,task.id,'claimed',{attempt});return {task,generation:c.generation,attempt}
   })
   if(!claimed)return
   const {task,generation,attempt}=claimed;abort=new AbortController()
   try{
    for(let phase=task.phase;phase<phases.length;phase++){
     activeGuard(task,generation,attempt)
     const reserved=tx(db=>{const c=control(db);if(c.spent+task.units>c.budget){db.prepare("UPDATE tide_tasks SET state='blocked_budget' WHERE id=?").run(task.id);record(db,task.id,'budget-blocked',phase);return false}db.prepare('UPDATE tide_task_control SET spent=spent+?').run(task.units);record(db,task.id,'reserved',{phase,units:task.units});return true})
     if(!reserved)break
     const guard=()=>activeGuard(task,generation,attempt)
     const result=await runCognitiveScope(guard,()=>{guard();return handlers[phases[phase]]({id:task.id,input:task.input,previous:task.checkpoint,phase:phases[phase],signal:abort.signal,guard,maxUnits:task.units,recordModelRequest:decision=>{guard();if(!['ordinary','help'].includes(decision?.kind)||!Number.isSafeInteger(decision.request)||decision.request<1||decision.request>task.units)throw Error('bounded model request audit required');tx(db=>record(db,task.id,'model-request',{phase:phases[phase],kind:decision.kind,reason:decision.reason,request:decision.request}))}})},{toolPolicy})
     validateText(result,4096);guard()
     tx(db=>{db.prepare('UPDATE tide_tasks SET phase=?,checkpoint=?,state=? WHERE id=? AND attempt=?').run(phase+1,result,phase===3?'done':'running',task.id,attempt);record(db,task.id,'checkpoint',{phase:phase+1,checkpoint:hash(result)})})
     task.checkpoint=result
    }
   }catch(error){
    // Record no exception text: it may contain a prompt or credentials.
    try{tx(db=>{const r=db.prepare('SELECT state,attempt FROM tide_tasks WHERE id=?').get(task.id);if(r?.state==='running'&&r.attempt===attempt){const state=error?.code==='TIDEMIND_OUTCOME_UNKNOWN'?'needs_review':abort.signal.aborted||control(db).rest?'paused':'failed';db.prepare('UPDATE tide_tasks SET state=? WHERE id=?').run(state,task.id);record(db,task.id,state,{phase:task.phase})}})}catch{/* lost authority leaves running for a NEW term to review */}
   }finally{abort=null}
  }
 }
 function kick(){if(disposed)return Promise.resolve();wake=true;if(job)return job;job=Promise.resolve().then(async()=>{do{wake=false;await drain()}while(wake&&!disposed)}).finally(()=>{job=null;if(wake&&!disposed)kick().catch(()=>{})});return job}
 function enqueue(task,{dryRun=false}={}){
  if(disposed)throw Error('scheduler disposed')
  if(!task||Object.keys(task).some(k=>!['id','input','units'].includes(k)))throw Error('task carries unsupported capability fields')
  validateText(task.id,160);validateText(task.input,8192);if(!task.id||!Number.isSafeInteger(task.units)||task.units<1||task.units>budget)throw Error('task identity and bounded units required')
  const signature=hash(task),result=tx(db=>{const old=db.prepare('SELECT signature FROM tide_tasks WHERE id=?').get(task.id);if(old){if(old.signature!==signature)throw Error('task conflict');return {id:task.id,replayed:true}}
   if(!dryRun){db.prepare("INSERT INTO tide_tasks VALUES(?,?,?,?,'queued',0,'',NULL,NULL)").run(task.id,signature,task.input,task.units);record(db,task.id,'enqueued',signature)}return {id:task.id,dryRun}
  });if(!dryRun)kick().catch(()=>{});return result
 }
 function requestRest(rest,{op,dryRun=false}={}){
  if(disposed)throw Error('scheduler disposed')
  if(typeof rest!=='boolean'||typeof op!=='string'||!op||op.length>160)throw Error('explicit rest state and operation ID required')
  const signature=hash({rest}),result=tx(db=>{if(!rest&&!sourceAutonomyAllowed(db))throw Error('source handover pause blocks autonomy resume');const old=db.prepare('SELECT * FROM tide_task_ops WHERE op=?').get(op);if(old){if(old.signature!==signature)throw Error('rest operation conflict');return {...JSON.parse(old.result),replayed:true}}
   const c=control(db);if(dryRun)return {rest,revision:c.revision,dryRun:true}
   if(c.rest!==(rest?1:0))db.prepare('UPDATE tide_task_control SET rest=?,generation=generation+1').run(rest?1:0)
   if(!rest)db.prepare("UPDATE tide_tasks SET state='queued' WHERE state='paused'").run()
   const revision=record(db,null,rest?'rest':'resume',{rest}),out={rest,revision};db.prepare('INSERT INTO tide_task_ops VALUES(?,?,?)').run(op,signature,JSON.stringify(out));return out
  })
  let pending=Promise.resolve()
  if(!dryRun&&!result.replayed){if(rest){for(const s of group)s.cancel();pending=Promise.allSettled([...group].map(s=>s.idle()))}else kick().catch(()=>{})}
  const receipt=()=>({...result,drained:!([...group].some(s=>s.active()))})
  return {...receipt(),completion:pending.then(receipt)}
 }
 async function setRest(rest,options){return requestRest(rest,options).completion}
 async function runActivity(task,fn){
  if(disposed||typeof fn!=='function')throw Error('active scheduler callback required')
  validateText(task?.id,160);validateText(task?.input,8192)
  if(!task.id||!Number.isSafeInteger(task.units)||task.units<1||task.units>budget)throw Error('bounded activity identity and units required')
  const signature=hash(task),claimed=tx(db=>{
   const c=control(db);if(c.rest)return {skipped:'rest'};if(!sourceAutonomyAllowed(db))return {skipped:'handover'}
   const old=db.prepare('SELECT signature,state FROM tide_tasks WHERE id=?').get(task.id)
   if(old){if(old.signature!==signature)throw Error('activity conflict');return {replayed:true,state:old.state}}
   if(c.spent+task.units>c.budget)return {skipped:'budget'}
   const attempt=randomUUID()
   db.prepare("INSERT INTO tide_tasks VALUES(?,?,?,?,'running',0,'',?,?)").run(task.id,signature,task.input,task.units,activeTerm(),attempt)
   db.prepare('UPDATE tide_task_control SET spent=spent+?').run(task.units)
   record(db,task.id,'activity-reserved',{units:task.units,attempt})
   return {attempt,generation:c.generation}
  })
  if(!claimed.attempt)return claimed
  const controller=new AbortController(),entry={controller,promise:null};external.set(task.id,entry)
  const guard=()=>{
   controller.signal.throwIfAborted();if(disposed)throw Error('scheduler disposed')
   tx(db=>{const c=control(db),r=db.prepare('SELECT state,attempt FROM tide_tasks WHERE id=?').get(task.id)
    if(c.rest||c.generation!==claimed.generation||r?.state!=='running'||r.attempt!==claimed.attempt)throw Error('activity paused or fenced')})
  }
  entry.promise=Promise.resolve().then(async()=>{
   try{
    const value=await runCognitiveScope(guard,()=>{guard();return fn({signal:controller.signal,guard,id:task.id})},{toolPolicy,signal:controller.signal})
    guard();tx(db=>{db.prepare("UPDATE tide_tasks SET state='done',phase=4 WHERE id=? AND attempt=?").run(task.id,claimed.attempt);record(db,task.id,'activity-done',task.id)})
    return {state:'done',value}
   }catch{
    try{tx(db=>{db.prepare("UPDATE tide_tasks SET state='needs_review' WHERE id=? AND attempt=?").run(task.id,claimed.attempt);record(db,task.id,'activity-needs-review',task.id)})}catch{}
    return {state:'needs_review'}
   }finally{external.delete(task.id)}
  })
  return entry.promise
 }
 const member={active:()=>abort!==null||external.size>0,cancel:()=>{abort?.abort(new Error('rest requested'));for(const e of external.values())e.controller.abort(new Error('rest requested'))},idle:async()=>{while(job||external.size){if(job)await job;if(external.size)await Promise.allSettled([...external.values()].map(e=>e.promise))}}}
 group.add(member)
 const close=async()=>{if(disposed)return;try{await setRest(true,{op:'close-'+instance})}finally{disposed=true;member.cancel();await Promise.allSettled([member.idle()]);group.delete(member);if(!group.size)groups.delete(key)}}
 const cancelActivity=async id=>{const entry=external.get(id);if(!entry)return {active:false};entry.controller.abort(new Error('module activity interrupted'));await entry.promise;return {active:false,drained:true}}
 const trace=(id,{after=0,limit=100}={})=>{validateText(id,160);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('bounded trace cursor required');return tx(db=>db.prepare('SELECT revision,task_id,event,digest FROM tide_task_log WHERE task_id=? AND revision>? ORDER BY revision LIMIT ?').all(id,after,limit))}
 return {enqueue,runActivity,cancelActivity,requestRest,setRest,status,trace,start:kick,idle:member.idle,close}
}
