import test from 'node:test'
import assert from 'node:assert/strict'
import {fixture} from './fixture.mjs'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
test('a brand-new tide_ table no longer locks the database (warn only), once',async()=>{
 const f=await fixture()
 try{
  const warns=[],orig=console.warn;console.warn=(...a)=>warns.push(a.join(' '))
  try{
   f.lease.fenced('local',f.term,db=>db.exec('CREATE TABLE IF NOT EXISTS tide_brand_new_module(x TEXT)'))
   f.lease.fenced('local',f.term,db=>db.prepare('SELECT 1').get());f.lease.fenced('local',f.term,db=>db.prepare('SELECT 1').get())
  }finally{console.warn=orig}
  assert.equal(warns.filter(w=>w.includes('tide_brand_new_module')).length,1,'warned exactly once')
 }finally{f.cleanup()}
})
test('a database with a non-tide_ table (e.g. a real memory DB) is still refused',async()=>{
 const f=await fixture()
 try{
  f.lease.fenced('local',f.term,db=>db.exec('CREATE TABLE memories(id TEXT)'))
  assert.throws(()=>f.lease.fenced('local',f.term,db=>db.prepare('SELECT 1').get()),/not an isolated lease database/)
 }finally{f.cleanup()}
})
