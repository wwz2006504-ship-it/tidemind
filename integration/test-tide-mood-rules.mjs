import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {createMoods} from './tide-moods.mjs'
import {scoreDialogue,applyDialogue} from './tide-mood-rules.mjs'
test('only the owner private chat scores; unmatched text changes nothing; one hit per mood per message',()=>{
 assert.deepEqual(scoreDialogue({text:'你真笨蛋,闭嘴',ownerPrivate:false,messageId:'1'}),[])
 assert.deepEqual(scoreDialogue({text:'今天天气不错',ownerPrivate:true,messageId:'1'}),[])
 const h=scoreDialogue({text:'笨蛋!闭嘴!滚!',ownerPrivate:true,messageId:'m1'});assert.equal(h.length,1);assert.equal(h[0].sin,'愤怒')
 const two=scoreDialogue({text:'对不起,我送你奶茶',ownerPrivate:true,messageId:'m2'});assert.deepEqual(two.map(x=>x.sin).sort(),['愤怒','暴食','贪婪'].sort())
})
test('applying is idempotent per message, small, and goes through the capped meters',async()=>{
 const f=await fixture(),t={now:1e12}
 try{
  const m=createMoods({lease:f.lease,holder:'local',term:f.term,clock:()=>t.now})
  applyDialogue(m,{text:'笨蛋',ownerPrivate:true,messageId:'a'});applyDialogue(m,{text:'笨蛋',ownerPrivate:true,messageId:'a'})
  assert.ok(Math.abs(m.snapshot().levels['愤怒']-0.14)<1e-9,'replayed message counted once')
  for(let i=0;i<20;i++)applyDialogue(m,{text:'笨蛋',ownerPrivate:true,messageId:'x'+i})
  assert.ok(m.snapshot().levels['愤怒']<=0.4+1e-9,'daily cap holds against spam')
  assert.equal(m.snapshot().recent[0].basis.includes('主人私聊'),true)
 }finally{f.cleanup()}
})
