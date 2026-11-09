import {test} from 'node:test'
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {fixture} from './fixture.mjs'
import {captureFreshBaseline,verifyFreshBaseline,observeMemorySource} from './fresh-baseline.mjs'
async function setup(){const f=await fixture(),file=join(f.root,'synthetic-original.txt');writeFileSync(file,'SYNTHETIC ORIGINAL');const files=Object.fromEntries(['hub','reply','identity','jsonMemory','config','sessions'].map(role=>[role,file]));return {...f,file,files,capture:()=>captureFreshBaseline({sourceFile:f.cloud,files,requiredCoreIds:[f.core.id]})}}
test('logical read-only receipt matches current snapshot; file rollback or original-memory changes invalidate it',async()=>{const f=await setup();try{
 const receipt=f.capture();assert.equal(verifyFreshBaseline(receipt,{local:f.local,snapshotFiles:f.files}).fresh,true);assert.equal(receipt.cutoverAuthorized,false)
 writeFileSync(f.file,'SYNTHETIC ROLLBACK');assert.throws(()=>verifyFreshBaseline(receipt,{local:f.local,snapshotFiles:f.files}),/source baseline changed/)
 writeFileSync(f.file,'SYNTHETIC ORIGINAL');const db=new DatabaseSync(f.cloud);try{db.prepare('UPDATE memories SET updated_at=updated_at+1 WHERE id=?').run(f.core.id)}finally{db.close()}
 assert.throws(()=>verifyFreshBaseline(receipt,{local:f.local,snapshotFiles:f.files}),/source baseline changed/)
}finally{f.cleanup()}})
test('fresh receipt cannot validate an older prepared snapshot or a missing required core record',async()=>{const f=await setup();try{
 const db=new DatabaseSync(f.cloud);try{db.prepare('UPDATE memories SET updated_at=updated_at+1 WHERE id=?').run(f.core.id)}finally{db.close()}
 const receipt=f.capture();assert.throws(()=>verifyFreshBaseline(receipt,{local:f.local,snapshotFiles:f.files}),/working snapshot is older/)
 assert.throws(()=>observeMemorySource(f.cloud,{requiredCoreIds:['missing-core']}),/required active core memory missing/)
 assert.throws(()=>verifyFreshBaseline(undefined,{local:f.local,snapshotFiles:f.files}),/fresh source baseline required/)
}finally{f.cleanup()}})
test('committed WAL changes are observed even while original connection remains open',async()=>{const f=await setup();let db;try{
 const before=f.capture();db=new DatabaseSync(f.cloud);db.exec('PRAGMA journal_mode=WAL');db.prepare('UPDATE memories SET updated_at=updated_at+1 WHERE id=?').run(f.core.id)
 assert.notEqual(f.capture().source.hash,before.source.hash)
 assert.throws(()=>verifyFreshBaseline(before,{local:f.local,snapshotFiles:f.files}),/source baseline changed/)
}finally{db?.close();f.cleanup()}})
test('current SQL does not excuse an older persona or JSON source copy',async()=>{const f=await setup();try{
 const receipt=f.capture(),old=join(f.root,'stale-sidecar.txt');writeFileSync(old,'SYNTHETIC OLDER PERSONALITY')
 for(const role of ['identity','jsonMemory','sessions'])assert.throws(()=>verifyFreshBaseline(receipt,{local:f.local,snapshotFiles:{...f.files,[role]:old}}),/snapshot original file differs/)
}finally{f.cleanup()}})
