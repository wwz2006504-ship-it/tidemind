// History frontier metadata in the ORIGINAL authority. The source signs actual
// SDK snapshots with its existing private materializer key, after input pause.
import {createHmac,timingSafeEqual} from 'node:crypto'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {assertCompositeAgreement} from './composite-head.mjs'
import {checkedSessionHistoryBundle,assertSessionBundleExtension} from './session-history-bundle.mjs'
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const publicHead=row=>({revision:row.revision,digest:row.digest,baseline:row.baseline,fourDigest:row.four_digest,op:row.pause_op,sourceHolder:row.holder,sourceTerm:row.term})
function mac(descriptor,key){if(typeof key!=='string'||key.length<32)throw Error('existing private history key required');return createHmac('sha256',key).update('tidemind-history-frontier-v1\0'+hash(descriptor)).digest('hex')}
export function signHistoryFrontier(descriptor,key){return {...descriptor,proof:mac(descriptor,key)}}
export function assertCanonicalFourFrontier(db,ack){
 assertCompositeAgreement(ack,ack,{required:true});const h=db.prepare('SELECT * FROM tide_head').get(),s=ack.composite.sqlite
 if(h.revision!==s.revision||h.hash!==s.hash||h.baseline_hash!==s.baseline||h.protected_hash!==s.protectedHash)throw Error('history belongs to another memory frontier')
 for(const [component,kind]of [['json','json'],['persona','persona'],['aiMemory','aiMemory']]){const row=db.prepare('SELECT * FROM tide_sidecar_states WHERE component=?').get(component),wanted=ack.composite[kind];if(!row||row.revision!==wanted.revision||row.digest!==wanted.hash||row.baseline!==wanted.baseline)throw Error('sidecar advanced before history acceptance')}
}
export function assertHistoryAckAgreement(db,{sourceAck,targetAck,holder,term,op,takeover=false,required=process.env.TIDEMIND_REQUIRE_SESSION_HISTORY==='1'}){
 const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tide_history_head'").get(),row=exists?db.prepare('SELECT * FROM tide_history_head WHERE id=1').get():null
 if(!required&&!row&&!sourceAck?.history&&!targetAck?.history)return
 if(!row)throw Error('verified session history frontier missing')
 if(!sourceAck?.history||!targetAck?.history)throw Error('session history acknowledgement missing')
 const expected=publicHead(row)
 if(hash(sourceAck?.history)!==hash(expected)||hash(targetAck?.history)!==hash(expected)||sourceAck?.composite?.digest!==row.four_digest||targetAck?.composite?.digest!==row.four_digest)throw Error('session histories differ; retain both copies')
 assertCanonicalFourFrontier(db,sourceAck)
 const gate=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get()
 if(gate.state!=='paused'||gate.op!==row.pause_op||gate.active!==0)throw Error('history source pause revoked or unresolved')
 if(!takeover&&(row.holder!==holder||row.term!==term||row.pause_op!==op))throw Error('history frontier belongs to another handover')
}
export function createSessionHistoryAuthority({lease,keys,initialDigest,initialBundle,currentFourHead}){
 if(initialDigest!==undefined&&!hex(initialDigest))throw Error('reviewed initial history digest required')
 // Keep the reviewed snapshot immutable. Chat may legitimately append events
 // between preparation and handover; an exact digest alone cannot prove ancestry.
 const baselineBundle=initialBundle===undefined?null:checkedSessionHistoryBundle(structuredClone(initialBundle))
 if(baselineBundle&&baselineBundle.digest!==initialDigest)throw Error('reviewed history baseline bundle differs from digest')
 const current=()=>{const db=lease.openAuthority();try{const row=db.prepare('SELECT * FROM tide_history_head WHERE id=1').get();return row?{found:true,head:publicHead(row),bundle:checkedSessionHistoryBundle(JSON.parse(row.body))}:{found:false}}finally{db.close()}}
 function publish(holder,term,{signed,bundle,ack}){
  const {proof,...descriptor}=signed||{},expected=mac(descriptor,keys?.[holder]);bundle=checkedSessionHistoryBundle(bundle)
  if(!hex(proof)||!timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(expected,'hex'))||descriptor.holder!==holder||descriptor.term!==term||descriptor.bundleDigest!==bundle.digest||descriptor.fourDigest!==ack?.composite?.digest||typeof descriptor.op!=='string'||!descriptor.op||descriptor.op.length>160)throw Error('signed original history frontier differs')
  const canonical=currentFourHead();if(canonical.digest!==descriptor.fourDigest)throw Error('canonical four-store history differs')
  const signature=hash({descriptor,ack})
  return lease.fenced(holder,term,db=>{
   const home=db.prepare('SELECT home FROM tide_head').get();if(home.home!==holder)throw Error('history source is standby');assertCanonicalFourFrontier(db,ack)
   const gate=db.prepare('SELECT * FROM tide_source_gate WHERE id=1').get(),barrier=db.prepare('SELECT * FROM tide_memory_barrier WHERE id=1').get()
   if(gate.state!=='paused'||gate.op!==descriptor.op||gate.active!==0||barrier.state!=='blocked'||barrier.op!==descriptor.op||barrier.holder!==holder||barrier.term!==term||db.prepare("SELECT count(*) n FROM tide_source_deferred WHERE state!='forwarded'").get().n)throw Error('paused drained source and blocked memory required for history frontier')
   const old=db.prepare('SELECT * FROM tide_history_head WHERE id=1').get()
   if(old?.pause_op===descriptor.op&&old.request_hash===signature)return {...publicHead(old),replayed:true}
   if((old?.revision||0)!==descriptor.expectedRevision||(old?.digest||null)!==descriptor.expectedDigest)throw Error('newer history frontier must not be overwritten')
   if(old)assertSessionBundleExtension(JSON.parse(old.body),bundle)
   else if(baselineBundle)assertSessionBundleExtension(baselineBundle,bundle)
   else if(!initialDigest||bundle.digest!==initialDigest)throw Error('history differs from reviewed initial baseline')
   const revision=(old?.revision||0)+1,baseline=old?.baseline||initialDigest
   db.prepare('INSERT INTO tide_history_head VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,digest=excluded.digest,baseline=excluded.baseline,body=excluded.body,four_digest=excluded.four_digest,holder=excluded.holder,term=excluded.term,pause_op=excluded.pause_op,request_hash=excluded.request_hash').run(revision,bundle.digest,baseline,JSON.stringify(bundle),descriptor.fourDigest,holder,term,descriptor.op,signature)
   return {revision,digest:bundle.digest,baseline,fourDigest:descriptor.fourDigest,op:descriptor.op,sourceHolder:holder,sourceTerm:term,replayed:false}
  })
 }
 return Object.freeze({current,publish})
}
