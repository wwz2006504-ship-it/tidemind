import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
// The add-on is Windows-only by design; pretend so for this logic test (no Windows APIs are used while resting).
const real=Object.getOwnPropertyDescriptor(process,'platform')
test('owner tool registers, lists, pauses, resumes and cancels goals while resting; no model is touched',async()=>{
 Object.defineProperty(process,'platform',{value:'win32'})
 const {mountDesktopPulse}=await import('./desktop-pulse.mjs')
 const root=realpathSync(mkdtempSync(join(tmpdir(),'tidemind-pulse-goals-')))
 let build,dispose,modelTouches=0
 const api={isOwner:id=>String(id)==='42',defineTool:x=>x,config:()=>({ownerQQ:'42'}),tool:fn=>{build=fn;return()=>{build=undefined}},on:()=>()=>{},onDispose:fn=>{dispose=fn},
  dsh:{get(){modelTouches++;throw Error('Rest must not load the model')}}}
 try{
  await mountDesktopPulse(api,{root,installId:'goals-test'})
  assert.equal(build({chat:{kind:'private',userId:'43'}}),null)
  const tool=build({chat:{kind:'private',userId:'42'}})
  assert.ok(tool.properties.action.enum.includes('goal_add'))
  const added=await tool.execute({action:'goal_add',goal:'在测试世界采集 32 个橡木原木'},{callId:'call-1'})
  assert.equal((await tool.execute({action:'goal_add',goal:'在测试世界采集 32 个橡木原木'},{callId:'call-1'})).replayed,true)
  const st=await tool.execute({action:'goal_status'});assert.equal(st.rest,true);assert.equal(st.goals.length,1);assert.equal(st.goals[0].state,'active')
  await assert.rejects(tool.execute({action:'goal_pause'}),/goal_id/)
  await tool.execute({action:'goal_pause',goal_id:added.id},{callId:'p'});assert.equal((await tool.execute({action:'goal_status'})).goals[0].state,'paused')
  await tool.execute({action:'goal_resume',goal_id:added.id},{callId:'r'});assert.equal((await tool.execute({action:'goal_status'})).goals[0].state,'active')
  await tool.execute({action:'goal_cancel',goal_id:added.id},{callId:'c'});assert.equal((await tool.execute({action:'goal_status'})).goals[0].state,'cancelled')
  const plain=await tool.execute({action:'status'});assert.equal(plain.rest,true);assert.equal(plain.spent,0);assert.equal(plain.goals.length,1)
  assert.match(plain.summary,/^休息中[｜；]/);assert.match(plain.summary,/目标 1 个/);assert.match(plain.summary,/任务 1 条/);assert.match(plain.summary,/预算 0\//);assert.equal(plain.goals[0].title.length>0,true);assert.equal(plain.goals[0].state,'cancelled');assert.ok('reason' in plain.goals[0]);assert.ok(!('checkpoint' in (plain.tasks[0]??{})))
  await assert.rejects(tool.execute({action:'goal_add',goal:'x'.repeat(2000)}),/bounded/)
  // Natural life / affect / traits through the same owner-only tool (proposals only; nothing is self-approved here).
  assert.ok(tool.properties.action.enum.includes('life_propose'))
  assert.equal((await tool.execute({action:'affect_status'})).simulated,true)
  assert.equal((await tool.execute({action:'traits_status'})).identity,null)
  await assert.rejects(tool.execute({action:'life_approve'}),/proposal_id/)
  await assert.rejects(tool.execute({action:'life_propose',goal:'读书',kind:'reading',basis:'b'}),/proposal_id/)
  const lp=await tool.execute({action:'life_propose',proposal_id:'lp1',goal:'读一篇文章',kind:'reading',basis:'空闲'})
  assert.ok(lp.ok===true||['quiet hours'].includes(lp.reason),'propose either records or is refused for a logged reason')
  assert.equal((await tool.execute({action:'goal_status'})).goals.filter(g=>g.source==='self').length,0,'a proposal never becomes a goal by itself')
  assert.equal((await tool.execute({action:'life_status'})).paused,false)
  const ms=await tool.execute({action:'moods_status'});assert.equal(Object.keys(ms.levels).length,7)
  assert.equal((await tool.execute({action:'moods_score',mood:'愤怒',delta:0.1,basis:'测试'},{callId:'m1'})).applied,0.1)
  await assert.rejects(tool.execute({action:'moods_score',mood:'愤怒',delta:0.1,basis:''}),/basis/)
  assert.equal(modelTouches,0)
  dispose()
  for(let i=0;i<100&&JSON.parse(readFileSync(join(root,'mounted.json'))).mounted;i++)await new Promise(r=>setTimeout(r,10))
  assert.equal(JSON.parse(readFileSync(join(root,'mounted.json'))).mounted,false)
 }finally{dispose?.();Object.defineProperty(process,'platform',real);rmSync(root,{recursive:true,force:true})}
})
