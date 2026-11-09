import test from 'node:test'
import assert from 'node:assert/strict'
import {createSense} from './tide-sense.mjs'
const mk=()=>{const t={now:1000};return {t,s:createSense({clock:()=>t.now,staleMs:5000})}}
test('observations are refused before connecting, only known fields accepted, and each carries a timestamp',()=>{
 const {t,s}=mk();assert.throws(()=>s.observe({health:20}),/not connected/)
 s.connect();assert.throws(()=>s.observe({plan:'x'}),/not an observable/)
 s.observe({health:20,position:{x:1,y:64,z:2}});const sn=s.snapshot()
 assert.equal(sn.observed.health.value,20);assert.equal(sn.observed.health.stale,false);assert.equal(sn.observed.hunger.stale,true,'never observed = stale, not zero')
})
test('observations go stale with time, and a disconnect makes everything stale immediately',()=>{
 const {t,s}=mk();s.connect();s.observe({health:20});t.now+=6000;assert.equal(s.snapshot().observed.health.stale,true)
 s.observe({health:18});assert.equal(s.snapshot().observed.health.stale,false)
 s.disconnect('服务器断开');const sn=s.snapshot();assert.equal(sn.observed.health.stale,true);assert.equal(sn.connection.connected,false);assert.equal(sn.events.at(-1).kind,'failure')
})
test('plan, observation and completion stay separate: a plan is not an observation, and completion needs fresh observed evidence',()=>{
 const {t,s}=mk();s.connect();s.setPlan({goal:'收集橡木',action:'砍树',next:'回家'})
 let sn=s.snapshot();assert.equal(sn.planned.action,'砍树');assert.equal(sn.completed.length,0);assert.equal(sn.observed.inventory.value,null)
 assert.throws(()=>s.complete({action:'砍树'}),/evidence/)
 assert.throws(()=>s.complete({action:'砍树',evidence:{field:'inventory'}}),/evidence/,'never observed')
 s.observe({inventory:{oak:3}});t.now+=6000;assert.throws(()=>s.complete({action:'砍树',evidence:{field:'inventory'}}),/stale/)
 s.observe({inventory:{oak:32}});s.complete({action:'砍树',evidence:{field:'inventory'}})
 sn=s.snapshot();assert.equal(sn.completed.length,1);assert.equal(sn.planned.action,null);assert.equal(sn.events.at(-1).kind,'success')
})
test('snapshots are frozen copies: mutating them cannot alter the live state, and the event list is bounded',()=>{
 const {s}=mk();s.connect();s.observe({inventory:{oak:1}});const sn=s.snapshot();sn.observed.inventory.value.oak=999
 assert.equal(s.snapshot().observed.inventory.value.oak,1)
 for(let i=0;i<50;i++)s.fail('a'+i,'why');assert.equal(s.snapshot().events.length,20)
})
