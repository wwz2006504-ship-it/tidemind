// Read-only logical source receipt. SQLite transactions include committed WAL data.
// This freshness check does NOT prove all writers are paused or authorize cutover.
import {DatabaseSync} from 'node:sqlite'
import {readFileSync,realpathSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dataHash} from '../TideMind/deploy/existing/tide-replica.mjs'
const sha=b=>createHash('sha256').update(b).digest('hex')
function sql(file,fn){const db=new DatabaseSync(realpathSync(file),{readOnly:true});try{db.exec('PRAGMA query_only=ON; BEGIN');return fn(db)}finally{try{db.exec('ROLLBACK')}finally{db.close()}}}
export function observeMemorySource(file,{requiredCoreIds=[]}={}){
 if(!Array.isArray(requiredCoreIds)||requiredCoreIds.some(id=>typeof id!=='string'||!id))throw Error('explicit required core IDs expected')
 return sql(file,db=>{
  const rows=db.prepare('SELECT * FROM memories ORDER BY id').all(),core=rows.filter(r=>r.layer==='core')
  for(const id of requiredCoreIds)if(!core.some(r=>r.id===id&&r.status==='active'&&r.valid_to===null))throw Error('required active core memory missing')
  return {hash:dataHash(db),count:rows.length,coreCount:core.length,coreHash:sha(JSON.stringify(core))}
 })
}
export function captureFreshBaseline({sourceFile,files,requiredCoreIds=[]}){
 if(!files||typeof files!=='object'||Array.isArray(files))throw Error('explicit original file roles required')
 const paths=Object.fromEntries(Object.entries(files).map(([role,file])=>[role,realpathSync(file)]))
 const fingerprint=()=>Object.fromEntries(Object.entries(paths).map(([role,file])=>[role,{file,sha256:sha(readFileSync(file))}]))
 const before=fingerprint(),source=observeMemorySource(sourceFile,{requiredCoreIds}),after=fingerprint()
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('source files changed during baseline observation')
 return {format:'tidemind-fresh-baseline-v1',observedAt:new Date().toISOString(),sourceFile:realpathSync(sourceFile),source,files:after,requiredCoreIds:[...requiredCoreIds],observationOnly:true,cutoverAuthorized:false}
}
export function verifyFreshBaseline(receipt,{local,requireAi=false,snapshotFiles}={}){
 if(receipt?.format!=='tidemind-fresh-baseline-v1'||!receipt.source?.hash||!local)throw Error('fresh source baseline required; old prepared copies cannot activate')
 const required=['hub','reply','identity','jsonMemory','config','sessions',...(requireAi?['aiMemory']:[])]
 for(const role of required)if(!receipt.files?.[role]?.file||!snapshotFiles?.[role])throw Error('fresh baseline missing original role or snapshot: '+role)
 const files=Object.fromEntries(Object.entries(receipt.files).map(([role,row])=>[role,row.file]))
 const now=captureFreshBaseline({sourceFile:receipt.sourceFile,files,requiredCoreIds:receipt.requiredCoreIds})
 if(JSON.stringify(now.source)!==JSON.stringify(receipt.source)||JSON.stringify(now.files)!==JSON.stringify(receipt.files))throw Error('source baseline changed; refresh snapshot and approval before activation')
 for(const role of required)if(sha(readFileSync(realpathSync(snapshotFiles[role])))!==now.files[role].sha256)throw Error('snapshot original file differs from current source: '+role)
 const baseline=sql(local,db=>db.prepare('SELECT baseline_hash FROM tidemind_replica WHERE id=1').get()?.baseline_hash)
 if(baseline!==now.source.hash)throw Error('working snapshot is older or differs from current source baseline')
 return {fresh:true,cutoverAuthorized:false,sourceHash:now.source.hash,count:now.source.count,coreCount:now.source.coreCount}
}
