import test from 'node:test'
import assert from 'node:assert/strict'
import {createCompositeHead,assertCompositeAgreement,assertCompositeTakeover} from './composite-head.mjs'
import {fixture} from './fixture.mjs'
const h='a'.repeat(64),b='b'.repeat(64)
const parts=sqlite=>({sqlite,aiMemory:{revision:0,hash:h,baseline:b},jsonMemory:{overlayRevision:0,overlayHash:h,baselineSha256:b},persona:{overlayVersion:0,currentHash:h,sha256:b}})
const receipt=sqlite=>({...sqlite,composite:createCompositeHead(parts(sqlite))})
test('identical composite histories match; missing, forged and changed stores stop',()=>{
 const sqlite={revision:0,hash:'GENESIS',data_hash:h,baseline_hash:b,protected_hash:h},a=receipt(sqlite)
 assert.doesNotThrow(()=>assertCompositeAgreement(a,structuredClone(a),{required:true}))
 assert.throws(()=>assertCompositeAgreement(sqlite,sqlite,{required:true}))
 for(const kind of ['jsonMemory','persona']){const p=parts(sqlite);if(kind==='jsonMemory'){p[kind].overlayRevision=1;p[kind].overlayHash=b}else{p[kind].overlayVersion=1;p[kind].currentHash=b}const changed={...sqlite,composite:createCompositeHead(p)};assert.throws(()=>assertCompositeAgreement(a,changed),/histories differ/)}
 const forged=structuredClone(a);forged.composite.json.revision=9;assert.throws(()=>assertCompositeAgreement(a,forged),/digest mismatch/)
 assert.throws(()=>assertCompositeTakeover(a,undefined));assert.doesNotThrow(()=>assertCompositeTakeover(a,a.composite))
})
test('existing gateway cannot release lease or switch home when composite receipt is missing or differs',async()=>{
 const f=await fixture();const before=process.env.TIDEMIND_REQUIRE_COMPOSITE_HANDOVER
 try{process.env.TIDEMIND_REQUIRE_COMPOSITE_HANDOVER='1';const a=f.replica.replicaHead(f.local),args={op:'composite-switch',target:'cloud',expectedRevision:0,expectedHash:'GENESIS',sourceAck:receipt(a),targetAck:receipt(a)}
 assert.throws(()=>f.gateway.handover(f.lease,'local',f.term,{...args,targetAck:a}));assert.equal(f.lease.status().holder,'local');assert.equal(f.gateway.head(f.lease).home,'local')
 const p=parts(a);p.persona.overlayVersion=1;p.persona.currentHash=b;assert.throws(()=>f.gateway.handover(f.lease,'local',f.term,{...args,targetAck:{...a,composite:createCompositeHead(p)}}),/histories differ/)
 assert.equal(f.lease.status().holder,'local');assert.equal(f.gateway.handover(f.lease,'local',f.term,args).target,'cloud');assert.equal(f.lease.status().holder,null)
 }finally{if(before===undefined)delete process.env.TIDEMIND_REQUIRE_COMPOSITE_HANDOVER;else process.env.TIDEMIND_REQUIRE_COMPOSITE_HANDOVER=before;f.cleanup()}
})

test('production requires independent ai-memory coverage even when the other three stores agree',()=>{
 const sqlite={revision:0,hash:'GENESIS',data_hash:h,baseline_hash:b,protected_hash:h},p=parts(sqlite);delete p.aiMemory
 const ack={...sqlite,composite:createCompositeHead(p)}
 assert.throws(()=>assertCompositeAgreement(ack,ack,{required:true}),/independent ai-memory coverage/)
 assert.throws(()=>assertCompositeTakeover(ack,ack.composite),/independent ai-memory coverage/)
})
