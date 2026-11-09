import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {DatabaseSync,backup} from 'node:sqlite'
import {fixture} from './fixture.mjs'
import {createSyncReceipts,signSyncReceipt} from './sync-receipts.mjs'
import {createCompositeHead} from './composite-head.mjs'
import {createSyncDelta,stageSyncDelta} from './sync-delta.mjs'
const sha=b=>createHash('sha256').update(b).digest('hex'),secret='SYNTHETIC PRIVATE SYNC KEY LONGER THAN 32 CHARACTERS',baseline='a'.repeat(64),slots=['memory.db','new-memories.json','persona-versions.json','ledger.jsonl']
async function setup(){const f=await fixture(),baseDirectory=join(f.root,'base'),nextDirectory=join(f.root,'next'),stagingDirectory=join(f.root,'incoming');for(const p of [baseDirectory,nextDirectory,stagingDirectory])mkdirSync(p)
 for(const [dir,revision]of [[baseDirectory,0],[nextDirectory,1]]){const db=new DatabaseSync(f.local,{readOnly:true});try{await backup(db,join(dir,'memory.db'))}finally{db.close()}for(const name of slots.slice(1))writeFileSync(join(dir,name),JSON.stringify({revision,value:'SYNTHETIC DAY '+revision}))}
 const verifyGeneration=dir=>{const j=JSON.parse(readFileSync(join(dir,slots[1]))),p=JSON.parse(readFileSync(join(dir,slots[2]))),a=JSON.parse(readFileSync(join(dir,slots[3])));return createCompositeHead({sqlite:f.replica.replicaHead(join(dir,'memory.db')),jsonMemory:{overlayRevision:j.revision,overlayHash:sha(readFileSync(join(dir,slots[1]))),baselineSha256:baseline},persona:{overlayVersion:p.revision,currentHash:sha(readFileSync(join(dir,slots[2]))),sha256:baseline},aiMemory:{revision:a.revision,hash:sha(readFileSync(join(dir,slots[3]))),baseline}})}
 const baseHead=verifyGeneration(baseDirectory),nextHead=verifyGeneration(nextDirectory),withSourceFence=({holder,term},fn)=>f.lease.fenced(holder,term,db=>{if(db.prepare('SELECT home FROM tide_head').get().home!==holder)throw Error('source not primary');return fn()})
 const options={baseDirectory,nextDirectory,baseHead,nextHead,op:'sync-test',holder:'local',term:f.term,target:'cloud',secret,withSourceFence,readCurrentComposite:()=>nextHead}
 const receive=packet=>stageSyncDelta({packet,baseDirectory,expectedBase:baseHead,stagingDirectory,secret,withSourceFence,verifyGeneration})
 return {...f,baseDirectory,nextDirectory,stagingDirectory,baseHead,nextHead,verifyGeneration,withSourceFence,options,receive}
}
test('signed incremental packet reconstructs all four candidate files and repeats without changing original base',async()=>{const f=await setup();try{const packet=createSyncDelta(f.options),before=slots.map(n=>readFileSync(join(f.baseDirectory,n)));await stageSyncDelta({packet,baseDirectory:f.baseDirectory,expectedBase:f.baseHead,stagingDirectory:f.stagingDirectory,secret,withSourceFence:f.withSourceFence,verifyGeneration:f.verifyGeneration,dryRun:true});assert.deepEqual(readdirSync(f.stagingDirectory),[])
 const result=await f.receive(packet);assert.equal(result.head.digest,f.nextHead.digest);for(const [i,name]of slots.entries()){assert.deepEqual(readFileSync(join(result.directory,name)),readFileSync(join(f.nextDirectory,name)));assert.deepEqual(readFileSync(join(f.baseDirectory,name)),before[i])}assert.equal((await f.receive(packet)).replayed,true)
 }finally{f.cleanup()}})
test('tampered signature, wrong target base and stale source term cannot publish a candidate',async()=>{const f=await setup();try{const packet=createSyncDelta(f.options),tampered=structuredClone(packet);tampered.files['ledger.jsonl'].insert='eA==';await assert.rejects(f.receive(tampered),/signature invalid/)
 await assert.rejects(stageSyncDelta({packet,baseDirectory:f.baseDirectory,expectedBase:f.nextHead,stagingDirectory:f.stagingDirectory,secret,withSourceFence:f.withSourceFence,verifyGeneration:f.verifyGeneration}),/target base differs/)
 f.lease.release('local',f.term);await assert.rejects(f.receive(packet));assert.deepEqual(readdirSync(f.stagingDirectory),[])
 }finally{f.cleanup()}})
test('source advanced after snapshot prevents signing and a reused operation cannot carry a new valid term',async()=>{const f=await setup();try{assert.throws(()=>createSyncDelta({...f.options,readCurrentComposite:()=>f.baseHead}),/source advanced/);const packet=createSyncDelta(f.options);await f.receive(packet);f.lease.release('local',f.term);const nextTerm=f.lease.acquire('local',{ttl:60000}).term;const changed=createSyncDelta({...f.options,term:nextTerm});await assert.rejects(f.receive(changed),/operation conflict/)}finally{f.cleanup()}})
test('cloud to local reverse requires explicit reviewed handover under the existing source lease',async()=>{const f=await setup();try{f.lease.release('local',f.term);const term=f.lease.acquire('cloud',{ttl:60000}).term;f.gateway.takeover(f.lease,'cloud',term,{expectedRevision:0,expectedHash:'GENESIS',targetAck:{...f.replica.replicaHead(f.local),composite:f.nextHead},expectedComposite:f.nextHead})
 const reverse={...f.options,holder:'cloud',term,target:'local'};assert.throws(()=>createSyncDelta(reverse),/reverse synchronization/);assert.throws(()=>createSyncDelta({...reverse,mode:'handover'}),/reviewed handover/)
 const materializerKeys={local:'SYNTHETIC LOCAL RECEIPT SIGNING KEY 12345',cloud:'SYNTHETIC CLOUD RECEIPT SIGNING KEY 67890'},receipts=createSyncReceipts({lease:f.lease,materializerKeys}),sourceAck={...f.replica.replicaHead(f.local),composite:f.nextHead},ticketId='return-local'
 receipts.begin({holder:'cloud',term,op:ticketId,target:'local',baseDigest:f.baseHead.digest,sourceAck})
 const authorizeHandover=proof=>receipts.authorizeReverse({ticketId,...proof})
 const packet=createSyncDelta({...reverse,mode:'handover',authorizeHandover});await assert.rejects(f.receive(packet),/reviewed handover/)
 const result=await stageSyncDelta({packet,baseDirectory:f.baseDirectory,expectedBase:f.baseHead,stagingDirectory:f.stagingDirectory,secret,withSourceFence:f.withSourceFence,verifyGeneration:f.verifyGeneration,authorizeHandover});assert.equal(result.head.digest,f.nextHead.digest)
 const targetAck={...f.replica.replicaHead(join(result.directory,'memory.db')),composite:result.head}
 receipts.accept(signSyncReceipt({op:packet.op,sourceHolder:'cloud',sourceTerm:term,target:'local',baseDigest:packet.baseHead.digest,packetSignature:packet.signature,ack:targetAck},materializerKeys.local))
 receipts.confirm({holder:'cloud',term,ticketId,receiptOp:packet.op,sourceAck})
 f.gateway.handover(f.lease,'cloud',term,{op:ticketId,target:'local',expectedRevision:0,expectedHash:'GENESIS',sourceAck,targetAck,ticketId})
 const local=f.lease.acquire('local',{ttl:60000});assert.ok(local.term>term);assert.equal(f.gateway.head(f.lease).home,'local');assert.equal(f.lease.renew('cloud',term).ok,false)
 }finally{f.cleanup()}})
