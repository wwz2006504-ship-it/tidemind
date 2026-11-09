// Adapter around the original AI-memory library and operations, not a new memory engine.
import {readFileSync,writeFileSync,existsSync,realpathSync,renameSync} from 'node:fs'
import {resolve,dirname,relative,isAbsolute,join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {createOperations} from '../host/ai-memory/src/index.js'
import {parseLedger,serializeLedger} from '../host/ai-memory/src/store.js'
import {foldEvents} from '../host/ai-memory/src/ledger.js'
import {assertCognitiveActive} from './activity-gate.mjs'
const hash=b=>createHash('sha256').update(b).digest('hex')
export function createProtectedAiMemory({source,baselineSha256,ownedRoot,directory,withWriteGuard}){
 if(typeof withWriteGuard!=='function'||!/^[a-f0-9]{64}$/.test(baselineSha256||''))throw Error('reviewed AI baseline and authority required')
 const root=realpathSync(ownedRoot),dir=realpathSync(directory),file=join(dir,'ledger.jsonl'),original=realpathSync(source),rel=relative(root,dir)
 if(!rel||rel.startsWith('..')||isAbsolute(rel)||file===original)throw Error('separate owned AI directory required')
 const baseline=()=>{const raw=readFileSync(original);if(hash(raw)!==baselineSha256)throw Error('original AI ledger changed; stop and review');return raw}
 const initial=baseline(),parsed=parseLedger(initial.toString('utf8')),baseState=foldEvents(parsed.events)
 if(parsed.problems.length||baseState.problems.length)throw Error('invalid original AI ledger')
 const pathGuard=()=>{if(realpathSync(dir)!==dir||existsSync(file)&&realpathSync(file)!==file)throw Error('AI ledger path changed')}
 const raw=()=>{pathGuard();baseline();if(!existsSync(file))return initial;const b=readFileSync(file);if(b.length>32*1024*1024||!b.subarray(0,initial.length).equals(initial))throw Error('AI baseline prefix changed');return b}
 const load=()=>{const bytes=raw();if(bytes.length&&!bytes.toString('utf8').endsWith('\n'))throw Error('AI ledger incomplete tail');const p=parseLedger(bytes.toString('utf8')),state=foldEvents(p.events);if(p.problems.length||state.problems.length)throw Error('AI ledger invalid or incomplete');for(const kind of ['nodes','persona','questions','cycles'])for(const [id,record]of baseState[kind])if(JSON.stringify(record)!==JSON.stringify(state[kind].get(id)))throw Error('protected original AI record changed');return {events:p.events,state,problems:[]}}
 // Real original operations use their existing lock on this private directory.
 const lib={dir,ledgerPath:file,load,commit(events){return withWriteGuard(()=>{
  assertCognitiveActive();const current=load();if(!Array.isArray(events)||events.length>100||events.some((e,i)=>e.seq!==current.state.seq+i+1))throw Error('AI sequence conflict')
  const state=foldEvents([...current.events,...events]);if(state.problems.length)throw Error('AI append does not fold cleanly')
  for(const kind of ['nodes','persona','questions','cycles'])for(const [id,record]of baseState[kind])if(JSON.stringify(record)!==JSON.stringify(state[kind].get(id)))throw Error('protected original AI record cannot change')
  const before=raw(),suffix=Buffer.from(serializeLedger(events));if(before.length+suffix.length>32*1024*1024)throw Error('AI ledger size budget exhausted')
  pathGuard();const tmp=file+'.tmp-'+randomUUID();writeFileSync(tmp,Buffer.concat([before,suffix]),{flag:'wx',mode:0o600});renameSync(tmp,file)
  return {ok:true,appended:events.length}
 })}}
 return Object.freeze({lib,operations:createOperations(lib),inspect(){const bytes=raw(),current=load();return {revision:current.events.length-parsed.events.length,hash:hash(bytes),baseline:baselineSha256,sourceReadOnly:true}},load})
}
