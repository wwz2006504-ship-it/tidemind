import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import * as gateway from './deploy/existing/tide-gateway.mjs'
import * as replica from './deploy/existing/tide-replica.mjs'
const root=mkdtempSync(join(tmpdir(),'tidemind-upgrade-'))
process.env.TIDEMIND_SANDBOX_ROOT=root
process.env.TIDEMIND_LEASE_DB=join(root,'default.db')
const original=await import('./deploy/existing/lease.mjs')
const schema=readFileSync(new URL('./tests/original-memory-schema.sql',import.meta.url),'utf8')
let serial=0
function fixture(){
 const dir=join(root,String(++serial));mkdirSync(dir)
 const file=join(dir,'lease.db')
 const lease={
  openAuthority:()=>original.openAuthority(file),
  acquire:(h,o={})=>original.acquire(h,{...o,file}),renew:(h,t,o={})=>original.renew(h,t,{...o,file}),
  release:(h,t)=>original.release(h,t,{file}),status:()=>original.status(file),
  fenced:(h,t,cb,o={})=>original.fenced(h,t,cb,{...o,file})}
 lease.acquire('local',{ttl:60000})
 const local=join(dir,'local.db'),cloud=join(dir,'cloud.db')
 for(const path of [local,cloud]){
  const db=new DatabaseSync(path);db.exec(schema)
  db.prepare("INSERT INTO persona(key,content,version,active,updated_at) VALUES('identity','SYNTHETIC IDENTITY',1,1,1)").run()
  db.prepare("INSERT INTO memories(id,layer,content,created_at,updated_at,norm_hash) VALUES('core-one','core','SYNTHETIC CORE',1,1,'core-hash')").run();db.close();replica.initializeReplica(path)
 }
 const baseline=replica.replicaHead(local)
 gateway.initialize(lease,{protectedIds:['core-one'],baseline})
 return {lease,local,cloud,dir,baseline}
}
function insert(id='new-one',content='麦克风 synthetic'){
 return {id,fields:{layer:'episodic',content,tags:'[]',status:'active',valid_to:null,superseded_by:null,created_at:1,updated_at:1,norm_hash:gateway.hash(content).slice(0,32)}}
}
function commit(f,op='op1',mutation=insert(),holder='local'){
 const s=f.lease.status(),h=gateway.head(f.lease)
 return gateway.commit(f.lease,holder,s.term,{op,expectedRevision:h.revision,expectedHash:h.hash,mutation})
}
function sync(f,file,home,switching=false){
 const expected=replica.replicaHead(file),sourceHead=gateway.head(f.lease)
 return replica.materialize(file,gateway.committedSince(f.lease,expected.revision),{expected,sourceHead,home,switching})
}
function count(file,where="1=1"){
 const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT count(*) n FROM memories WHERE '+where).get().n}finally{db.close()}
}
test('original schema and FTS preserved; committed rows materialize',()=>{
 const f=fixture();commit(f);sync(f,f.local,'local');sync(f,f.cloud,'cloud')
 assert.equal(count(f.local),2);assert.equal(replica.replicaHead(f.local).data_hash,replica.replicaHead(f.cloud).data_hash)
 const db=new DatabaseSync(f.local,{readOnly:true})
 try{assert.equal(db.prepare(`SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH '"麦克风"'`).get().n,1)}finally{db.close()}
})
test('stale final commit cannot enter authoritative journal',()=>{
 const f=fixture(),old=f.lease.status();f.lease.release('local',old.term)
 const now=f.lease.acquire('cloud');assert.equal(now.term,old.term+1)
 assert.throws(()=>gateway.commit(f.lease,'local',old.term,{op:'late',expectedRevision:0,expectedHash:'GENESIS',mutation:insert()}),/FENCED/)
 assert.equal(gateway.committedSince(f.lease).length,0)
})
test('op replay is idempotent and payload collision stops',()=>{
 const f=fixture(),a=commit(f);assert.equal(commit(f).revision,a.revision)
 const reordered=insert();reordered.fields=Object.fromEntries(Object.entries(reordered.fields).reverse());assert.equal(commit(f,'op1',reordered).revision,a.revision)
 assert.throws(()=>commit(f,'op1',insert('other')),/conflict/)
 assert.equal(gateway.committedSince(f.lease).length,1)
})
test('protected core/persona cannot enter journal',()=>{
 const f=fixture()
 assert.throws(()=>commit(f,'core',{id:'core-one',fields:{content:'overwrite',norm_hash:'0123456789abcdef0123456789abcdef'}}),/protected/)
 assert.throws(()=>commit(f,'persona',{id:'persona',fields:{content:'overwrite',norm_hash:'0123456789abcdef0123456789abcdef'}}),/protected/)
 assert.equal(gateway.head(f.lease).revision,0)
})
test('unannounced replica mutation stops instead of overwriting',()=>{
 const f=fixture();commit(f)
 const db=new DatabaseSync(f.local);db.prepare("UPDATE memories SET content='tampered' WHERE id='core-one'").run();db.close()
 assert.throws(()=>sync(f,f.local,'local'),/out-of-band|outside journal/)
 assert.equal(count(f.local),1)
})
test('handover rejects outdated acknowledgements',()=>{
 const f=fixture();commit(f);const h=gateway.head(f.lease),s=f.lease.status()
 assert.throws(()=>gateway.handover(f.lease,'local',s.term,{op:'switch',target:'cloud',expectedRevision:h.revision,expectedHash:h.hash,sourceAck:replica.replicaHead(f.local),targetAck:replica.replicaHead(f.cloud)}),/not synchronized/)
 assert.equal(gateway.head(f.lease).home,'local');assert.equal(f.lease.status().holder,'local')
})
test('local->standby; switch cloud; cloud updates; return equal, new terms',()=>{
 const f=fixture();commit(f);sync(f,f.local,'local');sync(f,f.cloud,'cloud')
 let h=gateway.head(f.lease),s=f.lease.status()
 const switchTo=target=>gateway.handover(f.lease,s.holder,s.term,{op:'switch-'+target,target,expectedRevision:h.revision,expectedHash:h.hash,sourceAck:replica.replicaHead(f.local),targetAck:replica.replicaHead(f.cloud)})
 switchTo('cloud');const cloud=f.lease.acquire('cloud');assert.equal(cloud.term,s.term+1)
 commit(f,'cloud-update',{id:'new-one',fields:{status:'withdrawn',updated_at:2}},'cloud')
 sync(f,f.cloud,'cloud')
 assert.throws(()=>sync(f,f.local,'local'),/reverse requires/)
 sync(f,f.local,'local',true)
 h=gateway.head(f.lease);s=f.lease.status();switchTo('local')
 const local=f.lease.acquire('local');assert.equal(local.term,cloud.term+1)
 assert.equal(replica.replicaHead(f.local).data_hash,replica.replicaHead(f.cloud).data_hash)
 assert.equal(count(f.local,"status='withdrawn'"),1)
 assert.equal(count(f.local,"layer='core'"),1)
})
test('revision CAS conflict and incomplete logs leave target unchanged',()=>{
 const f=fixture(),expected=replica.replicaHead(f.cloud);commit(f)
 assert.throws(()=>replica.materialize(f.cloud,[],{expected,sourceHead:gateway.head(f.lease),home:'cloud'}),/incomplete/)
 assert.deepEqual(replica.replicaHead(f.cloud),expected)
 const s=f.lease.status();assert.throws(()=>gateway.commit(f.lease,'local',s.term,{op:'bad',expectedRevision:0,expectedHash:'GENESIS',mutation:insert('second')}),/revision/)
})
test('same QQ event has one attempt across repeated/concurrent dispatch',async()=>{
 const f=fixture(),s=f.lease.status(),event={channel:'qq-private-synthetic',eventId:'event-1',payload:'synthetic reply'}
 const a=gateway.enqueue(f.lease,'local',s.term,event),b=gateway.enqueue(f.lease,'local',s.term,event)
 assert.equal(a.key,b.key);let sent=0
 const transport=async()=>{sent++;return {id:'qq-receipt-synthetic'}}
 await Promise.all([gateway.dispatch(f.lease,'local',s.term,a.key,transport),gateway.dispatch(f.lease,'local',s.term,a.key,transport)])
 assert.equal(sent,1)
 await gateway.dispatch(f.lease,'local',s.term,a.key,transport);assert.equal(sent,1)
 assert.throws(()=>gateway.enqueue(f.lease,'local',s.term,{...event,payload:'another reply'}),/conflict/)
})
test('ACK loss stays unknown and is never blindly resent; handover blocked',async()=>{
 const f=fixture(),s=f.lease.status(),h=gateway.head(f.lease)
 const event=gateway.enqueue(f.lease,'local',s.term,{channel:'qq',eventId:'lost',payload:'synthetic'})
 let sent=0;const transport=async()=>{sent++;throw new Error('ACK lost')}
 assert.equal((await gateway.dispatch(f.lease,'local',s.term,event.key,transport)).state,'unknown')
 await gateway.dispatch(f.lease,'local',s.term,event.key,transport);assert.equal(sent,1)
 assert.throws(()=>gateway.handover(f.lease,'local',s.term,{op:'unsafe',target:'cloud',expectedRevision:h.revision,expectedHash:h.hash,sourceAck:replica.replicaHead(f.local),targetAck:replica.replicaHead(f.cloud)}),/unresolved/)
})
test('stale holder cannot enqueue or dispatch after takeover',async()=>{
 const f=fixture(),s=f.lease.status(),event={channel:'qq',eventId:'e',payload:'reply'}
 const out=gateway.enqueue(f.lease,'local',s.term,event);f.lease.release('local',s.term);f.lease.acquire('cloud')
 assert.throws(()=>gateway.enqueue(f.lease,'local',s.term,event),/FENCED/)
 await assert.rejects(gateway.dispatch(f.lease,'local',s.term,out.key,async()=>assert.fail()),/FENCED/)
})
test.after(()=>rmSync(root,{recursive:true,force:true}))

test('expired heartbeat allows caught-up standby takeover; old term rejected',async()=>{
 const f=fixture();commit(f);sync(f,f.local,'local');sync(f,f.cloud,'cloud')
 const old=f.lease.status()
 assert.ok(f.lease.renew('local',old.term,{ttl:2}).ok)
 await new Promise(r=>setTimeout(r,10))
 const next=f.lease.acquire('cloud');assert.ok(next.ok);assert.equal(next.term,old.term+1)
 const h=gateway.head(f.lease)
 gateway.takeover(f.lease,'cloud',next.term,{expectedRevision:h.revision,expectedHash:h.hash,targetAck:replica.replicaHead(f.cloud)})
 assert.equal(gateway.head(f.lease).home,'cloud')
 assert.throws(()=>gateway.commit(f.lease,'local',old.term,{op:'stale',expectedRevision:h.revision,expectedHash:h.hash,mutation:insert('bad')}),/FENCED/)
 commit(f,'cloud-after-crash',insert('cloud-new'),'cloud')
})
test('single authority transport authenticates holder; forged holder ignored',async()=>{
 const {serveAuthority}=await import('./deploy/existing/tide-authority.mjs')
 const f=fixture()
 process.env.TIDEMIND_ALLOW_LEGACY_SYNTHETIC='1'
 process.env.TIDEMIND_LOCAL_TOKEN='synthetic-local-token'
 process.env.TIDEMIND_CLOUD_TOKEN='synthetic-cloud-token'
 process.env.TIDEMIND_PROTECTED_IDS='["core-one"]'
 process.env.TIDEMIND_AUTHORITY_PORT='0'
 process.env.TIDEMIND_BASELINE_DATA_HASH=f.baseline.data_hash
 process.env.TIDEMIND_BASELINE_PROTECTED_HASH=f.baseline.protected_hash
 const server=serveAuthority(f.lease)
 await new Promise(resolve=>server.once('listening',resolve))
 const url='http://127.0.0.1:'+server.address().port
 const request=(path,body,token)=>fetch(url+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(1000)})
 try{
  assert.equal((await request('/head',{},'wrong')).status,401)
  const h=gateway.head(f.lease),s=f.lease.status()
  const forged=await request('/commit',{holder:'local',term:s.term,op:'spoof',expectedRevision:h.revision,expectedHash:h.hash,mutation:insert()},'synthetic-cloud-token')
  assert.equal(forged.status,409);assert.equal(gateway.head(f.lease).revision,0)
  const valid=await request('/commit',{term:s.term,op:'valid',expectedRevision:h.revision,expectedHash:h.hash,mutation:insert()},'synthetic-local-token')
  assert.equal(valid.status,200);assert.equal((await valid.json()).revision,1)
  const outcomes=await Promise.all(['a','b'].map(id=>request('/commit',{term:s.term,op:'race-'+id,expectedRevision:1,expectedHash:gateway.head(f.lease).hash,mutation:insert('race-'+id)},'synthetic-local-token')))
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409])
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
 await assert.rejects(request('/head',{},'synthetic-local-token'))
 assert.equal(gateway.head(f.lease).revision,2)
})

test('authority restart retains terms, revision chain and dedup ledger',async()=>{
 const f=fixture();commit(f);const old=f.lease.status()
 const event=gateway.enqueue(f.lease,'local',old.term,{channel:'qq',eventId:'persist',payload:'reply'})
 let sent=0;await gateway.dispatch(f.lease,'local',old.term,event.key,async()=>{sent++;return {id:'receipt'}})
 gateway.initialize(f.lease,{protectedIds:['core-one'],baseline:f.baseline})
 assert.equal(f.lease.status().term,old.term);assert.equal(gateway.head(f.lease).revision,1)
 await gateway.dispatch(f.lease,'local',old.term,event.key,async()=>{sent++;return {id:'duplicate'}})
 assert.equal(sent,1)
 f.lease.release('local',old.term);assert.equal(f.lease.acquire('local').term,old.term+1)
})
test('clock regression stops renew, acquire and final write acceptance',()=>{
 const f=fixture(),s=f.lease.status(),db=f.lease.openAuthority()
 db.prepare('UPDATE lease SET updated_at=? WHERE id=1').run(Date.now()+60000);db.close()
 assert.equal(f.lease.status().valid,false)
 assert.equal(f.lease.acquire('cloud').reason,'clock-regression')
 assert.equal(f.lease.renew('local',s.term).ok,false)
 assert.throws(()=>commit(f),/FENCED/)
})

test('same revision with different baseline is rejected; replay keeps one FTS row',()=>{
 const f=fixture();commit(f);sync(f,f.cloud,'cloud')
 const before=replica.replicaHead(f.cloud),sourceHead=gateway.head(f.lease),entries=gateway.committedSince(f.lease)
 const repeated=replica.materialize(f.cloud,entries,{expected:before,sourceHead,home:'cloud'})
 assert.deepEqual(repeated,before);assert.equal(count(f.cloud),2)
 assert.throws(()=>replica.materialize(f.cloud,entries,{expected:before,sourceHead:{...sourceHead,baseline_hash:'different-baseline'},home:'cloud'}),/baseline mismatch/)
 assert.deepEqual(replica.replicaHead(f.cloud),before)
})
test('caller cannot bypass QQ dedup with alternate reply slots',()=>{
 const f=fixture(),s=f.lease.status()
 assert.throws(()=>gateway.enqueue(f.lease,'local',s.term,{channel:'qq',eventId:'same',slot:'another',payload:'reply'}),/one stable reply/)
})
