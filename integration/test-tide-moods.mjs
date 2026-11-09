import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {createMoods,SINS} from './tide-moods.mjs'
const H=3600e3,D=86400e3
const mk=async(o={})=>{const f=await fixture(),t={now:1e12};return {f,t,m:createMoods({lease:f.lease,holder:'local',term:f.term,clock:()=>t.now,...o})}}
test('seven independent meters start at baseline; a score needs a basis, is capped per event, and replays are ignored',async()=>{
 const {f,m}=await mk()
 try{
  assert.equal(SINS.length,7);const s=m.snapshot();assert.ok(SINS.every(x=>s.levels[x]===0.1));assert.deepEqual(s.expressionHints,[])
  assert.equal(m.score({sin:'愤怒',delta:0.9,basis:'被反复辱骂',op:'a'}).applied,0.1)
  assert.equal(m.score({sin:'愤怒',delta:0.9,basis:'被反复辱骂',op:'a'}).replayed,true)
  assert.throws(()=>m.score({sin:'愤怒',delta:0.1,basis:' ',op:'b'}),/basis/);assert.throws(()=>m.score({sin:'骄傲',delta:0.1,basis:'x',op:'c'}),/unknown/)
  assert.equal(m.snapshot().levels['懒惰'],0.1,'meters do not move each other (not zero-sum)')
 }finally{f.cleanup()}
})
test('daily cap stops grinding a meter up in one day; negative scores lower it; decay returns it toward baseline',async()=>{
 const {f,t,m}=await mk()
 try{
  for(let i=0;i<6;i++)m.score({sin:'傲慢',delta:0.1,basis:'夸奖'+i,op:'u'+i})
  assert.ok(Math.abs(m.snapshot().levels['傲慢']-0.4)<1e-9,'0.1 baseline + 0.3 day cap');assert.equal(m.score({sin:'傲慢',delta:0.1,basis:'x',op:'more'}).capped,true)
  t.now+=D+1;m.score({sin:'傲慢',delta:-0.1,basis:'被指出错误并接受',op:'d'});assert.ok(m.snapshot().levels['傲慢']<0.4)
  t.now+=30*D;assert.ok(Math.abs(m.snapshot().levels['傲慢']-0.1)<0.01)
 }finally{f.cleanup()}
})
test('high levels give at most two non-critical expression hints',async()=>{
 const {f,t,m}=await mk({dayCap:1})
 try{
  for(const [s,n] of [['愤怒',5],['色欲',4],['贪婪',4]])for(let i=0;i<n;i++)m.score({sin:s,delta:0.1,basis:'b',op:s+i})
  const sn=m.snapshot();assert.equal(sn.expressionHints.length,2);assert.match(sn.scope,/never overrides safety/)
 }finally{f.cleanup()}
})
test('a sustained high level only opens one review notice; it changes nothing by itself',async()=>{
 const {f,t,m}=await mk({dayCap:1,halfLifeMs:1e15})
 try{
  for(let i=0;i<8;i++)m.score({sin:'嫉妒',delta:0.1,basis:'b'+i,op:'e'+i});assert.ok(m.snapshot().levels['嫉妒']>=0.7)
  assert.deepEqual(m.checkReviews(),[],'not sustained yet')
  t.now+=4*D;const ids=m.checkReviews();assert.equal(ids.length,1);assert.deepEqual(m.checkReviews(),[],'only one open notice')
  assert.ok(m.snapshot().levels['嫉妒']>=0.7,'the notice did not alter the meter');m.closeReview(ids[0],'已看过');assert.equal(m.snapshot().reviews.length,0)
 }finally{f.cleanup()}
})
