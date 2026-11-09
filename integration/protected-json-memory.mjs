// Original JSON remains an immutable input. Only NEW records live in the overlay.
import {readFileSync,realpathSync,writeFileSync,renameSync,existsSync} from 'node:fs'
import {resolve,relative,isAbsolute,dirname} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
const sha=b=>createHash('sha256').update(b).digest('hex')
const canonical=v=>JSON.stringify(sort(v))
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v}
export function createProtectedJsonMemory({source,expectedSha256,overlay,ownedRoot,withWriteGuard}){
 if(typeof withWriteGuard!=='function')throw Error('authority guard required')
 if(!/^[a-f0-9]{64}$/.test(expectedSha256||''))throw Error('reviewed memory fingerprint required')
 const root=realpathSync(ownedRoot),parent=realpathSync(dirname(overlay)),target=resolve(parent,resolve(overlay).split(/[\\/]/).at(-1)),rel=relative(root,target)
 if(!rel||rel.startsWith('..')||isAbsolute(rel)||realpathSync(source)===target)throw Error('separate owned overlay required')
 const sourcePath=realpathSync(source)
 function baseline(){const raw=readFileSync(sourcePath);if(sha(raw)!==expectedSha256)throw Error('original JSON memory changed; re-review required');const s=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));if(!s||!Array.isArray(s.items)||s.items.some(x=>!x||typeof x.id!=='string')||new Set(s.items.map(x=>x.id)).size!==s.items.length)throw Error('invalid original JSON memory');return s}
 const original=baseline(),ids=new Set(original.items.map(x=>x.id))
 function assertPath(){if(realpathSync(dirname(target))!==parent)throw Error('overlay directory changed');if(existsSync(target)&&realpathSync(target)!==target)throw Error('overlay link prohibited')}
 function additions(){assertPath();if(!existsSync(target))return {items:[],rev:0};const s=JSON.parse(readFileSync(target,'utf8'));if(s.baselineSha256!==expectedSha256||!Array.isArray(s.items)||s.items.some(x=>!x||typeof x.id!=='string'||ids.has(x.id))||new Set(s.items.map(x=>x.id)).size!==s.items.length)throw Error('invalid memory overlay');return s}
 function load(){const b=baseline(),o=additions();return structuredClone({...b,...o,baselineSha256:expectedSha256,items:[...b.items,...o.items],rev:o.rev||0,_tideOverlayRevision:o.overlayRevision||0})}
 // Recall counters are volatile metadata; retain originals byte-for-byte, never write them back.
 const semantic=x=>{const c=structuredClone(x);for(const k of ['hits','lastHit','hitDays'])delete c[k];return canonical(c)}
 function save(state){return withWriteGuard(()=>{
  const b=baseline(),current=additions()
  if(state?._tideOverlayRevision!==(current.overlayRevision||0))throw Error('JSON memory overlay revision conflict')
  if(!state||!Array.isArray(state.items)||state.items.some(x=>!x||typeof x.id!=='string')||new Set(state.items.map(x=>x.id)).size!==state.items.length)throw Error('invalid memory save')
  const proposed=new Map(state.items.map(x=>[x.id,x]))
  for(const old of b.items)if(!proposed.has(old.id)||semantic(proposed.get(old.id))!==semantic(old))throw Error('protected original JSON memory cannot change')
  const next={...state,items:state.items.filter(x=>!ids.has(x.id)),baselineSha256:expectedSha256,overlayRevision:(current.overlayRevision||0)+1}
  delete next._tideOverlayRevision
  assertPath();const tmp=target+'.tmp-'+randomUUID()
  // Private overlay directory must already exist; never creates paths beside the original.
  writeFileSync(tmp,JSON.stringify(next),'utf8');renameSync(tmp,target)
 })}
 return Object.freeze({load,save,inspect:()=>{baseline();const o=additions();return {overlayRevision:o.overlayRevision||0,overlayHash:sha(canonical(o)),protectedRecords:ids.size,baselineSha256:expectedSha256,sourceReadOnly:true,overlayOnly:true}}})
}
