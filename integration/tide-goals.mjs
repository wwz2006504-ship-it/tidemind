// TideGoal: persistent multi-round goals on top of the EXISTING task scheduler (same DB, budget, rest, fencing).
// A finished round never means a finished goal: only the judge's explicit verdict completes it.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
const STATES=['active','paused','blocked','completed','cancelled','failed']
const text=(s,max,name)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw Error(name+' must be bounded text');return s}
const INSTRUCTION='\n\n请只推进这一小步。回复最后一行必须以 DONE:（目标已真正完成）、BLOCKED:（遇阻无法继续）或 CONTINUE:（还需要下一步）开头，后面写一句话结果。'
export const defaultJudge=({result})=>{
 const line=String(result||'').split('\n').findLast(l=>/^(DONE|BLOCKED|CONTINUE):/.test(l.trim()))
 const m=line&&/^(DONE|BLOCKED|CONTINUE):\s*(.*)$/.exec(line.trim())
 if(!m)return {status:'continue',summary:String(result||'').slice(0,500)}
 return {status:{DONE:'completed',BLOCKED:'blocked',CONTINUE:'continue'}[m[1]],summary:m[2].slice(0,500)}
}
export function createGoals({lease,holder,term,scheduler,judge=defaultJudge,maxSteps=5}){
 if(!scheduler||typeof scheduler.enqueue!=='function'||typeof judge!=='function')throw Error('existing scheduler and judge required')
 if(!Number.isSafeInteger(maxSteps)||maxSteps<1||maxSteps>50)throw Error('bounded step limit required')
 const activeTerm=()=>typeof term==='function'?term():term
 const tx=fn=>lease.fenced(holder,activeTerm(),fn)
 tx(db=>db.exec(`CREATE TABLE IF NOT EXISTS tide_goals(id TEXT PRIMARY KEY,signature TEXT NOT NULL,title TEXT NOT NULL,source TEXT NOT NULL,priority INTEGER NOT NULL,state TEXT NOT NULL,steps_done INTEGER NOT NULL,max_steps INTEGER NOT NULL,summary TEXT NOT NULL,reason TEXT NOT NULL,current_task TEXT);
  CREATE TABLE IF NOT EXISTS tide_goal_steps(goal_id TEXT NOT NULL,n INTEGER NOT NULL,task_id TEXT NOT NULL,outcome TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(goal_id,n));`))
 const opOnce=(db,op,sig,fn)=>{
  if(typeof op!=='string'||!op||op.length>160)throw Error('operation ID required')
  const key='goal:'+op,old=db.prepare('SELECT signature,result FROM tide_task_ops WHERE op=?').get(key)
  if(old){if(old.signature!==sig)throw Error('goal operation conflict');return {...JSON.parse(old.result),replayed:true}}
  const out=fn();db.prepare('INSERT INTO tide_task_ops VALUES(?,?,?)').run(key,sig,JSON.stringify(out));return out
 }
 const cur_max=(db,id)=>db.prepare('SELECT max_steps FROM tide_goals WHERE id=?').get(id).max_steps
 const get=(db,id)=>{const g=db.prepare('SELECT * FROM tide_goals WHERE id=?').get(id);if(!g)throw Error('unknown goal');return g}
 function addGoal({id,title,source='owner',priority=3,maxSteps:limit=maxSteps},{op}={}){
  text(id,120,'goal id');text(title,1500,'goal title');text(source,60,'source')
  if(!Number.isSafeInteger(priority)||priority<1||priority>5||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('bounded priority and step limit required')
  const sig=hash({id,title,source,priority,limit})
  const out=tx(db=>opOnce(db,op??'add:'+id,sig,()=>{
   const old=db.prepare('SELECT signature FROM tide_goals WHERE id=?').get(id)
   if(old){if(old.signature!==sig)throw Error('goal conflict');return {id,existing:true}}
   db.prepare("INSERT INTO tide_goals VALUES(?,?,?,?,?,'active',0,?,'','',NULL)").run(id,sig,title,source,priority,limit);return {id}
  }))
  pump();return out
 }
 function setState(id,from,to,op,reason,{cancelQueued=false,moreSteps=0}={}){
  return tx(db=>opOnce(db,op,hash({id,to,moreSteps}),()=>{
   const g=get(db,id);if(!from.includes(g.state))throw Error('goal is '+g.state+'; cannot become '+to)
   if(to==='active'&&g.steps_done>=g.max_steps&&moreSteps<1)throw Error('step limit reached; resume with moreSteps')
   db.prepare('UPDATE tide_goals SET state=?,reason=?,max_steps=max_steps+? WHERE id=?').run(to,reason,moreSteps,id)
   if(cancelQueued&&g.current_task)db.prepare("UPDATE tide_tasks SET state='cancelled' WHERE id=? AND state='queued'").run(g.current_task)
   return {id,state:to}
  }))
 }
 const pause=(id,{op}={})=>setState(id,['active'],'paused',op??'pause:'+id+':'+Date.now(),'paused by owner')
 const cancel=(id,{op}={})=>setState(id,['active','paused','blocked'],'cancelled',op??'cancel:'+id,'cancelled by owner',{cancelQueued:true})
 function resume(id,{op,moreSteps=0}={}){const out=setState(id,['paused','blocked'],'active',op??'resume:'+id+':'+Date.now(),'',{moreSteps});pump();return out}
 // Queue the next small step of every active goal that has none in flight.
 function pump(){
  const todo=tx(db=>db.prepare("SELECT * FROM tide_goals WHERE state='active' AND current_task IS NULL AND steps_done<max_steps ORDER BY priority DESC,id").all())
  for(const g of todo){
   const n=g.steps_done+1,taskId='goal:'+g.id+':'+n
   const input=JSON.stringify({goal:g.title,step:n,of:g.max_steps,sofar:g.summary})+INSTRUCTION
   scheduler.enqueue({id:taskId,input,units:1})
   tx(db=>{db.prepare("UPDATE tide_goals SET current_task=? WHERE id=? AND state='active' AND current_task IS NULL").run(taskId,g.id)})
  }
  return todo.length
 }
 // Fold finished steps back into goals. Judge may call a model, so it runs outside the authority transaction.
 async function settle(){
  const rows=tx(db=>db.prepare("SELECT g.*,t.state tstate,t.checkpoint FROM tide_goals g JOIN tide_tasks t ON t.id=g.current_task WHERE g.state='active'").all())
  let changed=0
  for(const g of rows){
   if(['queued','running'].includes(g.tstate))continue
   let verdict
   if(g.tstate==='done'){
    try{verdict=await judge({goal:{id:g.id,title:g.title,step:g.steps_done+1,of:g.max_steps},result:g.checkpoint})}catch{verdict={status:'blocked',summary:'judge failed'}}
    if(!verdict||!['continue','completed','blocked'].includes(verdict.status)||typeof verdict.summary!=='string')verdict={status:'blocked',summary:'judge returned no valid verdict'}
   }else verdict={status:'blocked',summary:{needs_review:'step needs review',blocked_budget:'budget exhausted',failed:'step failed',paused:'step paused',cancelled:'step cancelled'}[g.tstate]||'step '+g.tstate,hold:true}
   const done=tx(db=>{
    const cur=db.prepare('SELECT state,current_task,steps_done FROM tide_goals WHERE id=?').get(g.id)
    if(cur.state!=='active'||cur.current_task!==g.current_task)return false
    const n=cur.steps_done+1,summary=verdict.summary.slice(0,1000)
    db.prepare('INSERT OR IGNORE INTO tide_goal_steps VALUES(?,?,?,?,?)').run(g.id,n,g.current_task,verdict.status,summary)
    if(verdict.hold){ // not a verdict from the work itself: do not count as progress
     db.prepare("UPDATE tide_goals SET state='blocked',reason=?,current_task=NULL WHERE id=?").run(verdict.summary,g.id);return true}
    const limit=verdict.status==='continue'&&n>=cur_max(db,g.id)
    const state=verdict.status==='completed'?'completed':verdict.status==='blocked'||limit?'blocked':'active'
    db.prepare('UPDATE tide_goals SET state=?,steps_done=?,summary=?,reason=?,current_task=NULL WHERE id=?').run(state,n,summary,limit?'step limit reached before completion':verdict.status==='blocked'?summary:'',g.id)
    return true
   })
   if(done)changed++
  }
  return changed
 }
 // One bounded pass; call again whenever the scheduler goes idle or on a timer. Never loops by itself.
 async function tick(){const settled=await settle();const queued=pump();return {settled,queued}}
 const status=()=>tx(db=>({goals:db.prepare('SELECT id,title,source,state,priority,steps_done,max_steps,summary,reason FROM tide_goals ORDER BY id').all(),
  steps:db.prepare('SELECT goal_id,n,outcome,note FROM tide_goal_steps ORDER BY goal_id,n').all()}))
 return Object.freeze({addGoal,pause,resume,cancel,tick,pump,settle,status,STATES})
}
