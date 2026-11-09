import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import {createGoals,defaultJudge} from './tide-goals.mjs'
// handlers answer by goal step so the verify phase carries the verdict line.
const handlers=answer=>Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async c=>p==='verify'?answer(JSON.parse(c.input.split('\n\n')[0])):p+' ok']))
async function setup(answer,opts={}){
 const f=await fixture(),sched=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:handlers(answer),budget:opts.budget??40})
 const goals=createGoals({lease:f.lease,holder:'local',term:f.term,scheduler:sched,maxSteps:opts.maxSteps??5})
 const run=async()=>{for(let i=0;i<12;i++){await sched.idle();const r=await goals.tick();if(!r.settled&&!r.queued&&!sched.status().tasks.some(t=>['queued','running'].includes(t.state)))break}}
 return {f,sched,goals,run,close:async()=>{await sched.close();f.cleanup()}}
}
test('default judge reads the last verdict line and treats anything else as continue',()=>{
 assert.deepEqual(defaultJudge({result:'x\nDONE: 完成了'}),{status:'completed',summary:'完成了'})
 assert.equal(defaultJudge({result:'BLOCKED: 没材料\n尾巴'}).status,'blocked')
 assert.equal(defaultJudge({result:'随便说说'}).status,'continue')
})
test('a goal runs several rounds and completes only on an explicit DONE; ending a round is not completion',async()=>{
 const s=await setup(c=>c.step<3?'CONTINUE: 第'+c.step+'步完成':'DONE: 全部完成')
 try{
  s.goals.addGoal({id:'oak',title:'收集 32 个橡木原木'});assert.equal(s.goals.status().goals[0].state,'active')
  await s.sched.setRest(false,{op:'wake'});await s.run()
  const st=s.goals.status();assert.equal(st.goals[0].state,'completed');assert.equal(st.goals[0].steps_done,3)
  assert.deepEqual(st.steps.map(x=>x.outcome),['continue','continue','completed'])
 }finally{await s.close()}
})
test('while resting nothing runs; blocked verdict stops and keeps the reason; explicit resume continues',async()=>{
 let blocked=true;const s=await setup(c=>c.step===1?'CONTINUE: 先备料':c.step===2&&blocked?'BLOCKED: 没有斧头':'DONE: ok')
 try{
  s.goals.addGoal({id:'g',title:'建房子'});await s.run();assert.equal(s.sched.status().control.spent,0);assert.equal(s.goals.status().goals[0].steps_done,0)
  await s.sched.setRest(false,{op:'wake'});await s.run()
  let g=s.goals.status().goals[0];assert.equal(g.state,'blocked');assert.equal(g.reason,'没有斧头');assert.equal(g.steps_done,2)
  const spent=s.sched.status().control.spent;await s.run();assert.equal(s.sched.status().control.spent,spent,'blocked goal must not keep spending')
  assert.throws(()=>s.goals.resume('nope',{op:'rx'}),/unknown goal/)
  blocked=false;s.goals.resume('g',{op:'r1'});await s.run()
  g=s.goals.status().goals[0];assert.equal(g.state,'completed');assert.equal(g.steps_done,3)
 }finally{await s.close()}
})
test('idempotent add, conflicting add rejected, pause/resume/cancel rules, queued step cancelled',async()=>{
 const s=await setup(()=>'CONTINUE: 继续')
 try{
  const a=s.goals.addGoal({id:'a',title:'目标A'},{op:'o1'});assert.equal(s.goals.addGoal({id:'a',title:'目标A'},{op:'o1'}).replayed,true)
  assert.throws(()=>s.goals.addGoal({id:'a',title:'别的'},{op:'o2'}),/conflict/)
  s.goals.pause('a',{op:'p1'});assert.equal(s.goals.status().goals[0].state,'paused')
  assert.throws(()=>s.goals.pause('a',{op:'p2'}),/cannot become/)
  s.goals.resume('a',{op:'r1'});assert.equal(s.goals.status().goals[0].state,'active')
  s.goals.cancel('a',{op:'c1'});const st=s.goals.status().goals[0];assert.equal(st.state,'cancelled')
  assert.equal(s.sched.status().tasks.find(t=>t.id==='goal:a:1').state,'cancelled')
  await s.sched.setRest(false,{op:'wake'});await s.run();assert.equal(s.sched.status().control.spent,0)
  assert.throws(()=>s.goals.resume('a',{op:'r2'}),/cannot become/)
 }finally{await s.close()}
})
test('step limit blocks instead of completing; resume needs explicit extra steps',async()=>{
 const s=await setup(()=>'CONTINUE: 还没好',{maxSteps:2})
 try{
  s.goals.addGoal({id:'long',title:'永远做不完'});await s.sched.setRest(false,{op:'wake'});await s.run()
  const g=s.goals.status().goals[0];assert.equal(g.state,'blocked');assert.equal(g.steps_done,2);assert.match(g.reason,/step limit/)
  assert.throws(()=>s.goals.resume('long',{op:'r1'}),/step limit/)
  s.goals.resume('long',{op:'r2',moreSteps:1});await s.run();assert.equal(s.goals.status().goals[0].steps_done,3)
 }finally{await s.close()}
})
test('budget exhaustion blocks the goal without counting a fake step; no refund',async()=>{
 const s=await setup(()=>'CONTINUE: 好',{budget:6})
 try{
  s.goals.addGoal({id:'b',title:'预算有限'});await s.sched.setRest(false,{op:'wake'});await s.run()
  const g=s.goals.status().goals[0];assert.equal(g.state,'blocked');assert.equal(g.steps_done,1);assert.match(g.reason,/budget/);assert.ok(s.sched.status().control.spent<=6)
 }finally{await s.close()}
})
test('restart: a step interrupted by the old term becomes blocked for review, never silently re-run',async()=>{
 const f=await fixture();let sched,sched2,release,started=false
 try{
  const h=Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>{if(p==='reflect'){started=true;return new Promise(r=>{release=r})}return p}]))
  sched=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:h,budget:40});const goals=createGoals({lease:f.lease,holder:'local',term:f.term,scheduler:sched})
  goals.addGoal({id:'r',title:'重启测试'});await sched.setRest(false,{op:'wake'})
  for(let i=0;i<300&&!started;i++)await new Promise(r=>setTimeout(r,5))
  assert.ok(started)
  f.lease.release('local',f.term);const t2=f.lease.acquire('local',{ttl:60000}).term;assert.equal(t2,f.term+1)
  let calls=0;sched2=createTaskCheckpoints({...f,term:t2,toolPolicy:'read-only',handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>{calls++;return p}])),budget:40})
  const goals2=createGoals({lease:f.lease,holder:'local',term:t2,scheduler:sched2})
  await goals2.tick();const g=goals2.status().goals[0]
  assert.equal(g.state,'blocked');assert.equal(g.steps_done,0);assert.match(g.reason,/review/)
  await sched2.setRest(false,{op:'wake2'});await sched2.idle();await goals2.tick();assert.equal(calls,0,'interrupted step must not re-run')
 }finally{release?.('late');await new Promise(r=>setTimeout(r,20));for(const x of [sched2,sched])try{await x?.close()}catch{};f.cleanup()}
})
