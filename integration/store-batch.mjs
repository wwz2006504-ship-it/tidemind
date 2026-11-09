// Exact original-store batches. Imported by the SAME gateway and replica.
import {createHmac,timingSafeEqual} from 'node:crypto'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
export const writable=['memories','memory_events','meta']
export function tableRows(db,table){return db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()}
export function storeHash(db){return hash(['memories','memory_events','meta','persona','persona_versions'].map(t=>[t,tableRows(db,t)]))}
export function identityHash(db){return hash([tableRows(db,'memories').filter(r=>r.layer==='core'),tableRows(db,'persona'),tableRows(db,'persona_versions')])}
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v
function signature(batch){
 const key=process.env.TIDEMIND_STORE_SIGNING_KEY
 if(!key||key.length<32)throw new Error('trusted store signing key required')
 const {proof,...body}=batch
 return createHmac('sha256',key).update(JSON.stringify(ordered(body))).digest('hex')
}
export function sealBatch(batch){return {...batch,proof:signature(batch)}}
export function verifyBatch(batch){
 if(batch.format!=='original-store-session-v1'||!Array.isArray(batch.changesets)||batch.changesets.length>3||!Array.isArray(batch.touched))throw new Error('invalid store batch')
 for(const field of ['before','after','protected','requestHash'])if(!/^[a-f0-9]{64}$/.test(batch[field]))throw new Error('invalid store fingerprint')
 for(const item of batch.changesets)if(!writable.includes(item.table)||typeof item.data!=='string'||item.data.length>1000000)throw new Error('invalid changeset')
 const a=Buffer.from(batch.proof||'','hex'),b=Buffer.from(signature(batch),'hex')
 if(a.length!==b.length||!timingSafeEqual(a,b))throw new Error('unverified store batch')
 return true
}
export function applyStoreBatch(db,batch){
 verifyBatch(batch)
 if(storeHash(db)!==batch.before||identityHash(db)!==batch.protected)throw new Error('store snapshot conflict')
 for(const item of batch.changesets){
  if(!db.applyChangeset(Buffer.from(item.data,'base64'),{filter:table=>table===item.table}))throw new Error('original store constraint conflict')
 }
 if(storeHash(db)!==batch.after||identityHash(db)!==batch.protected)throw new Error('store result mismatch')
}
