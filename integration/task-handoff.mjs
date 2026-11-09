// Cross-host continuation of the EXISTING task checkpoint tables (tide_task_*). No second scheduler.
// export: only while resting and fully quiesced. import: only a strict, verified extension of the target's own log.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
const FORMAT='tidemind-task-handoff-v1'
const need=db=>{if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='tide_task_control'").get())throw Error('task tables not initialised')}
const snapshot=db=>({control:db.prepare('SELECT rest,generation,revision,spent,budget FROM tide_task_control').get(),
 tasks:db.prepare('SELECT id,signature,input,units,state,phase,checkpoint FROM tide_tasks ORDER BY id').all(),
 log:db.prepare('SELECT revision,task_id,event,digest FROM tide_task_log ORDER BY revision').all()})
export function exportTaskState(lease,holder,term){
 return lease.fenced(holder,term,db=>{need(db);const s=snapshot(db)
  if(s.control.rest!==1)throw Error('task state can only be exported while resting')
  if(s.tasks.some(t=>t.state==='running'))throw Error('running task must be drained before export')
  const body={format:FORMAT,...s};return {...body,digest:hash(body)}
 })
}
export function importTaskState(lease,holder,term,bundle,{op,dryRun=false}={}){
 if(typeof op!=='string'||!op||op.length>160)throw Error('operation ID required')
 if(!bundle||bundle.format!==FORMAT)throw Error('unknown task handoff format')
 const {digest,...body}=bundle;if(hash(body)!==digest)throw Error('task handoff digest mismatch')
 return lease.fenced(holder,term,db=>{need(db)
  const key='handoff:'+op,old=db.prepare('SELECT signature FROM tide_task_ops WHERE op=?').get(key)
  if(old){if(old.signature!==digest)throw Error('handoff operation conflict');return {replayed:true,revision:body.control.revision}}
  const mine=snapshot(db)
  if(mine.tasks.some(t=>t.state==='running'))throw Error('target has a running task')
  if(mine.control.budget!==body.control.budget)throw Error('budget differs; explicit review required')
  // Target log must be an exact prefix of the bundle log; otherwise the target is newer or the histories diverged.
  if(mine.log.length>body.log.length)throw Error('target is newer than bundle; refusing to overwrite')
  for(let i=0;i<mine.log.length;i++)if(hash(mine.log[i])!==hash(body.log[i]))throw Error('task history diverged; stop and review')
  const out={imported:body.log.length-mine.log.length,revision:body.control.revision,tasks:body.tasks.length}
  if(dryRun)return {...out,dryRun:true}
  const ins=db.prepare('INSERT INTO tide_tasks VALUES(?,?,?,?,?,?,?,NULL,NULL)'),upd=db.prepare('UPDATE tide_tasks SET state=?,phase=?,checkpoint=? WHERE id=?')
  for(const t of body.tasks){const cur=mine.tasks.find(x=>x.id===t.id)
   if(!cur)ins.run(t.id,t.signature,t.input,t.units,t.state,t.phase,t.checkpoint)
   else{if(cur.signature!==t.signature)throw Error('task identity conflict');upd.run(t.state,t.phase,t.checkpoint,t.id)}}
  const addLog=db.prepare('INSERT INTO tide_task_log VALUES(?,?,?,?)')
  for(const l of body.log.slice(mine.log.length))addLog.run(l.revision,l.task_id,l.event,l.digest)
  // Always arrive resting: the owner resumes explicitly after the handoff is verified.
  db.prepare('UPDATE tide_task_control SET rest=1,generation=generation+1,revision=?,spent=?').run(body.control.revision,body.control.spent)
  db.prepare('INSERT INTO tide_task_ops VALUES(?,?,?)').run(key,digest,JSON.stringify(out))
  return out
 })
}
