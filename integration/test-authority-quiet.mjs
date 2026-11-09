import {test} from 'node:test'
import assert from 'node:assert/strict'
import {runtimeBootstrapFixture} from './runtime-bootstrap-fixture.mjs'
import {inspectAuthorityQuiet} from './authority-quiet.mjs'
test('actual original authority tables are read under pause and do not claim whole-runtime silence',async()=>{
 const f=await runtimeBootstrapFixture();try{const r=await f.start();const read=()=>inspectAuthorityQuiet({lease:f.lease,holder:'local',term:f.term})
 assert.equal(read().quiet,false);r.sourceAdmission.pause('quiet-evidence');const proof=read();assert.equal(proof.quiet,true);assert.equal(proof.wholeRuntimeQuiet,false)
 await f.emit(f.event(19444));assert.equal(read().counts.deferred,1);assert.equal(read().quiet,false)
 }finally{await f.cleanup()}
})
test('unknown outgoing or unverified admission blocks and no payload is exposed',async()=>{
 const f=await runtimeBootstrapFixture();try{const r=await f.start();r.sourceAdmission.pause('unknown-send');f.lease.fenced('local',f.term,db=>{db.prepare("INSERT INTO tide_outbox VALUES('synthetic','hash','PRIVATE SYNTHETIC','local',?,'unknown','attempt',NULL)").run(f.term);db.prepare("INSERT INTO tide_admissions VALUES('admission','session','private:20001','[]','hash','flushed_unverified',?)").run(f.term)})
 const proof=inspectAuthorityQuiet({lease:f.lease,holder:'local',term:f.term});assert.equal(proof.quiet,false);assert.equal(proof.counts.outgoing,1);assert.equal(proof.counts.admissions,1);assert.ok(!JSON.stringify(proof).includes('PRIVATE SYNTHETIC'))
 }finally{await f.cleanup()}
})
test('candidate original outbound drains its completed reply and watchdog stays paused',async()=>{
 const f=await runtimeBootstrapFixture();try{const r=await f.start();assert.equal(r.host.transferLifecycle.status().watchdogPaused,false)
 await f.emit(f.event(19445));r.sourceAdmission.pause('actual-send-drain');await r.sourceAdmission.drain();await r.host.hub.drainIncoming();await r.host.transferLifecycle.drainOutbound();await r.host.transferLifecycle.drainWatchdog()
 assert.equal(f.sent.length,1);assert.equal(r.host.transferLifecycle.status().watchdogPaused,true);assert.equal(r.host.transferLifecycle.status().watchdogActive,0)
 const proof=inspectAuthorityQuiet({lease:f.lease,holder:'local',term:f.term});assert.equal(proof.quiet,true,JSON.stringify(proof));assert.equal(proof.wholeRuntimeQuiet,false)
 }finally{await f.cleanup()}
})

test('failed remote callback and unknown tool results remain blockers after counter reaches zero',async()=>{
 const f=await runtimeBootstrapFixture();try{const r=await f.start();r.sourceAdmission.pause('failed-outcomes')
 f.lease.fenced('local',f.term,db=>{
  db.prepare("INSERT INTO tide_source_callbacks VALUES('callback:test','hash','local',?,'review')").run(f.term)
  db.prepare("INSERT INTO tide_tool_permits VALUES('tool:test','hash','approval','session','call','get_cookies','hash','local',?,?,'unknown','attempt','hash')").run(f.term,Date.now()+30000)
 })
 const proof=inspectAuthorityQuiet({lease:f.lease,holder:'local',term:f.term})
 assert.equal(proof.counts.sourceCallbacks,0);assert.equal(proof.counts.remoteCallbacks,1);assert.equal(proof.counts.toolOutcomes,1);assert.equal(proof.quiet,false)
 }finally{await f.cleanup()}
})
