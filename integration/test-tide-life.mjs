import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import {createGoals} from './tide-goals.mjs'
import {createLife} from './tide-life.mjs'
const H=3600e3,noon=Date.UTC(2026,10,9,12,0,0)
async function setup(config={}){
 const f=await fixture(),sched=createTaskCheckpoints({...f,toolPolicy:'read-only',handlers:Object.fromEntries(['observe','reflect','plan','verify'].map(p=>[p,async()=>'DONE: ok'])),budget:40})
 const goals=createGoals({lease:f.lease,holder:'local',term:f.term,scheduler:sched}),t={now:noon}
 const life=createLife({lease:f.lease,holder:'local',term:f.term,goals,clock:()=>t.now,config:{utcOffsetMin:0,...config}})
 return {f,sched,goals,life,t,close:async()=>{await sched.close();f.cleanup()}}
}
test('proposal is only a proposal: no goal until the owner approves, then it is a low-priority self goal',async()=>{
 const s=await setup()
 try{
  const r=s.life.propose({id:'p1',kind:'memory-summary',title:'整理今天的记忆摘要',basis:'今天对话较多'});assert.equal(r.ok,true)
  assert.equal(s.goals.status().goals.length,0)
  s.life.approve('p1');const g=s.goals.status().goals;assert.equal(g.length,1);assert.equal(g[0].source,'self');assert.equal(g[0].priority,1)
  assert.equal(s.life.approve('p1').state,'approved');assert.equal(s.goals.status().goals.length,1,'approving twice must not duplicate')
 }finally{await s.close()}
})
test('risky kinds, quiet hours, cooldown, pending cap, duplicates and global pause are all refused with a logged reason',async()=>{
 const s=await setup()
 try{
  const ok=(id,title,kind='reading')=>s.life.propose({id,kind,title,basis:'b'})
  assert.equal(ok('a','买东西','purchase').reason,'not a low-risk kind')
  assert.equal(ok('b','读一篇').ok,true)
  assert.equal(ok('c','再读一篇').reason,'proposal cooldown')
  s.t.now+=7*H;assert.equal(ok('d','读一篇').reason,'duplicate')
  assert.equal(ok('e','写反思','reflection').ok,true)
  s.t.now=Date.UTC(2026,10,10,12,0,0);assert.equal(ok('f','列计划','planning').ok,true)
  s.t.now+=7*H;assert.equal(ok('g','整理笔记','tidy-notes').reason,'too many pending')
  s.life.reject('b');s.t.now=Date.UTC(2026,10,11,2,0,0);assert.equal(ok('h','夜里读书').reason,'quiet hours')
  s.t.now=Date.UTC(2026,10,11,12,0,0);s.life.pause();assert.equal(ok('i','白天读书').reason,'paused')
  s.life.resume();assert.equal(ok('i','白天读书').ok,true)
  assert.ok(s.life.status().log.some(x=>!x.allowed&&x.reason==='quiet hours'),'refusals are explained in the log')
 }finally{await s.close()}
})
test('never chases a silent owner: one unanswered message blocks the next until the owner replies, plus cooldown and quiet hours',async()=>{
 const s=await setup()
 try{
  assert.equal(s.life.canSend().ok,true);s.life.noteSent('想分享今天的发现')
  s.t.now+=30*H;assert.equal(s.life.canSend().reason,'waiting for a reply')
  s.life.noteOwnerReply();assert.equal(s.life.canSend().ok,true,'cooldown passed after 30h')
  s.life.noteSent('x');s.life.noteOwnerReply();s.t.now+=1*H;assert.equal(s.life.canSend().reason,'message cooldown')
  s.t.now=Date.UTC(2026,10,12,23,30,0);assert.equal(s.life.canSend().reason,'quiet hours')
 }finally{await s.close()}
})
test('proposal id conflict is rejected and replay is idempotent',async()=>{
 const s=await setup()
 try{
  s.life.propose({id:'p',kind:'reading',title:'A',basis:'b'})
  assert.equal(s.life.propose({id:'p',kind:'reading',title:'A',basis:'b'}).replayed,true)
  assert.throws(()=>s.life.propose({id:'p',kind:'reading',title:'B',basis:'b'}),/conflict/)
  assert.throws(()=>s.life.approve('zz'),/unknown proposal/)
 }finally{await s.close()}
})
