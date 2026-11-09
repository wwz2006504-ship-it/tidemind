import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {createAffect,EMOTIONS} from './tide-affect.mjs'
import {createTraits} from './tide-traits.mjs'
const H=3600e3,D=86400e3
async function setup(){const f=await fixture(),t={now:1e12};return {f,t,clock:()=>t.now,args:{lease:f.lease,holder:'local',term:f.term}}}
test('affect: one event moves a state only a little, it decays by half-life, each change needs a basis, replays are ignored',async()=>{
 const s=await setup()
 try{
  const a=createAffect({...s.args,clock:s.clock})
  assert.equal(a.apply({emotion:'开心',delta:0.9,basis:'主人夸了她',op:'e1'}).value,0.25,'a single event is capped')
  assert.equal(a.apply({emotion:'开心',delta:0.9,basis:'主人夸了她',op:'e1'}).replayed,true)
  assert.equal(a.snapshot().states['开心'],0.25)
  s.t.now+=3*H;assert.equal(a.snapshot().states['开心'],0.125)
  assert.throws(()=>a.apply({emotion:'开心',delta:0.1,basis:'',op:'e2'}),/basis/)
  assert.throws(()=>a.apply({emotion:'愤怒',delta:0.1,basis:'x',op:'e3'}),/unknown emotion/)
  const snap=a.snapshot();assert.equal(snap.simulated,true);assert.equal(Object.keys(snap.states).length,EMOTIONS.length)
  assert.equal(snap.recent[0].basis,'主人夸了她')
 }finally{s.f.cleanup()}
})
test('affect: dominant shows at most two states above a threshold; states can coexist',async()=>{
 const s=await setup()
 try{
  const a=createAffect({...s.args,clock:s.clock})
  a.apply({emotion:'好奇',delta:0.25,basis:'b',op:'1'});a.apply({emotion:'好奇',delta:0.25,basis:'b',op:'2'})
  a.apply({emotion:'失落',delta:0.2,basis:'b',op:'3'});a.apply({emotion:'开心',delta:0.15,basis:'b',op:'4'});a.apply({emotion:'害怕',delta:0.05,basis:'b',op:'5'})
  assert.deepEqual(a.snapshot().dominant,['好奇','失落'])
 }finally{s.f.cleanup()}
})
test('traits: only reliable experiences count; enough of them make a CANDIDATE, never an automatic change; owner approval moves it by one small step',async()=>{
 const s=await setup()
 try{
  const t=createTraits({...s.args,clock:s.clock})
  assert.equal(t.record({trait:'好奇',direction:1,reliable:false,basis:'传闻',op:'u'}).counted,false)
  for(let i=1;i<=4;i++)assert.equal(t.record({trait:'好奇',direction:1,reliable:true,basis:'经历'+i,op:'r'+i}).candidate,undefined)
  assert.equal(t.traits()['好奇'],0.5,'no change without a candidate')
  const r=t.record({trait:'好奇',direction:1,reliable:true,basis:'经历5',op:'r5'});assert.ok(r.candidate)
  assert.equal(t.traits()['好奇'],0.5,'a candidate alone changes nothing')
  assert.equal(t.record({trait:'好奇',direction:1,reliable:true,basis:'再来',op:'r6'}).candidate,undefined,'one candidate per trait at a time')
  t.approve(r.candidate);assert.equal(t.traits()['好奇'],0.52);assert.equal(t.approve(r.candidate).replayed,true);assert.equal(t.traits()['好奇'],0.52)
  assert.equal(t.traits()['谨慎'],0.5,'dimensions are independent')
 }finally{s.f.cleanup()}
})
test('traits: rate limit after a decision, opposite experiences cancel out, rejection keeps the value',async()=>{
 const s=await setup()
 try{
  const t=createTraits({...s.args,clock:s.clock})
  for(let i=1;i<=4;i++)t.record({trait:'谨慎',direction:1,reliable:true,basis:'a'+i,op:'p'+i})
  for(let i=1;i<=4;i++)t.record({trait:'谨慎',direction:-1,reliable:true,basis:'b'+i,op:'n'+i})
  assert.equal(t.candidates().length,0,'+4 and -4 cancel')
  for(let i=5;i<=9;i++)t.record({trait:'谨慎',direction:1,reliable:true,basis:'a'+i,op:'p'+i})
  const c=t.candidates();assert.equal(c.length,1);t.reject(c[0].id);assert.equal(t.traits()['谨慎'],0.5)
  for(let i=10;i<=20;i++)t.record({trait:'谨慎',direction:1,reliable:true,basis:'a'+i,op:'p'+i})
  assert.equal(t.candidates().length,1,'cooldown blocks a new candidate right after a decision')
  s.t.now+=8*D;t.record({trait:'谨慎',direction:1,reliable:true,basis:'late',op:'late'});assert.equal(t.candidates().length,2)
 }finally{s.f.cleanup()}
})
test('identity core: unconfirmed change refused, every version kept, revert restores the old one',async()=>{
 const s=await setup()
 try{
  const t=createTraits({...s.args,clock:s.clock})
  assert.equal(t.identity(),null)
  assert.throws(()=>t.setIdentity({text:'汐羽',reason:'init'}),/confirmation/)
  assert.equal(t.setIdentity({text:'汐羽 v1',reason:'初始',confirmed:true}).v,1)
  assert.equal(t.setIdentity({text:'汐羽 v1',reason:'同',confirmed:true}).unchanged,true)
  assert.equal(t.setIdentity({text:'汐羽 v2',reason:'大改',confirmed:true}).v,2)
  assert.throws(()=>t.revertIdentity(1),/confirmation/)
  t.revertIdentity(1,{confirmed:true});assert.equal(t.identity().text,'汐羽 v1');assert.equal(t.history().length,2)
 }finally{s.f.cleanup()}
})
