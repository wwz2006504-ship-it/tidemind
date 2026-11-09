// Test subprocess only. No model, QQ, desktop profile or local grants.
if(process.argv.includes('--dry-run')){console.log('{"dryRun":true,"testOnly":true}');process.exit(0)}
import {realpathSync} from 'node:fs'
import {join,relative,isAbsolute} from 'node:path'
import {fixture,dataRoot} from './fixture.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
const mode=process.env.TIDEMIND_TASK_TEST_MODE
if(mode==='checkpoint'){
 const f=await fixture();let ready
 const started=new Promise(r=>{ready=r}),handlers=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async c=>{
  if(p==='reflect'){ready();await new Promise((resolve,reject)=>{if(c.signal.aborted)reject(c.signal.reason);else c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true})})}
  return p+' saved'
 }]))
 const s=createTaskCheckpoints({...f,handlers,budget:8});s.enqueue({id:'process-task',input:'synthetic',units:1});await s.setRest(false,{op:'wake'});await started;await s.setRest(true,{op:'rest'});f.lease.release('local',f.term)
 console.log(JSON.stringify({root:f.root,phase:'checkpoint-ready'}));setInterval(()=>{},1000)
}else if(mode==='resume'){
 const root=realpathSync(process.env.TIDEMIND_TASK_TEST_ROOT),rel=relative(realpathSync(dataRoot),root)
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('test root outside data directory')
 process.env.TIDEMIND_SANDBOX_ROOT=root;process.env.TIDEMIND_LEASE_DB=join(root,'lease.db')
 const lease=await import('../TideMind/deploy/existing/lease.mjs'),term=lease.acquire('local').term,calls=[]
 const handlers=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>{calls.push(p);return p+' saved'}]))
 const s=createTaskCheckpoints({lease,term,handlers,budget:8});await s.start();const before=s.status();await s.setRest(false,{op:'resume'});await s.idle();const after=s.status()
 console.log(JSON.stringify({restBefore:before.control.rest,phaseBefore:before.tasks[0].phase,spentBefore:before.control.spent,stateAfter:after.tasks[0].state,spentAfter:after.control.spent,calls}));await s.close()
}else throw Error('explicit test mode required')
