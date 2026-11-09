// Asynchronous remote commits around ORIGINAL sidecar operations on private plans.
// Active files are published only after authoritative acceptance, never provisionally edited.
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,renameSync,unlinkSync,rmSync,realpathSync,openSync,fsyncSync,closeSync} from 'node:fs'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {createProtectedJsonMemory} from './protected-json-memory.mjs'
import {createIdentityBinding} from './identity-binding.mjs'
import {createPersonaVersions} from './persona-versions.mjs'
import {createProtectedAiMemory} from './protected-ai-memory.mjs'
import {assertCognitiveActive} from './activity-gate.mjs'
const files={json:'new-memories.json',persona:'persona-versions.json',aiMemory:'ledger.jsonl'},sha=b=>createHash('sha256').update(b).digest('hex')
export function createRemoteSidecars({authority,holder='local',term,ownedRoot,directory,journalDirectory,spec,getOperationId=()=>randomUUID()}){
 if(typeof authority?.request!=='function'||!Number.isSafeInteger(term)||term<1||!['local','cloud'].includes(holder))throw Error('explicit remote sidecar authority required')
 const root=realpathSync(ownedRoot),dir=checkedPath(directory),journal=join(checkedPath(journalDirectory),'pending-sidecar.json');if(root!==realpathSync(process.env.TIDEMIND_SANDBOX_ROOT))checkedPath(root);let queue=Promise.resolve()
 const checked=p=>{checkedPath(p);if(existsSync(p)&&realpathSync(p)!==p)throw Error('sidecar path link refused');return p}
 const atomic=(path,body)=>{checked(path);const temp=path+'.tmp-'+randomUUID(),fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,body);fsyncSync(fd)}finally{closeSync(fd)}renameSync(temp,path)}
 const loadPending=()=>existsSync(checked(journal))?JSON.parse(readFileSync(journal,'utf8')):null
 function adapters(at,guard){return {
  json:createProtectedJsonMemory({source:join(spec.sourceDataRoot,'memories.json'),expectedSha256:spec.pins.jsonMemory,ownedRoot:root,overlay:join(at,files.json),withWriteGuard:guard}),
  persona:createPersonaVersions({identity:createIdentityBinding({directory:join(spec.sourceDataRoot,'personas'),selected:spec.selectedPersona,expectedSha256:spec.pins.persona}),ownedRoot:root,stateFile:join(at,files.persona),withWriteGuard:guard}),
  aiMemory:createProtectedAiMemory({source:spec.aiSource,baselineSha256:spec.aiBaselineSha256,ownedRoot:root,directory:at,withWriteGuard:guard}),
 }}
 const active=adapters(dir,()=>{throw Error('active sidecar writes must use remote transaction')})
 function descriptor(component,adapter=active[component],at=dir){const i=adapter.inspect(),r=component==='json'?{revision:i.overlayRevision,digest:i.overlayHash,baseline:i.baselineSha256}:component==='persona'?{revision:i.overlayVersion,digest:i.currentHash,baseline:i.sha256}:{revision:i.revision,digest:i.hash,baseline:i.baseline};return {...r,fileHash:sha(readFileSync(checked(join(at,files[component]))))}}
 const same=(a,b)=>a.revision===b.revision&&a.digest===b.digest&&a.fileHash===b.fileHash
 async function owner(){const grant=await authority.request('/admin',{command:'status'});if(grant.holder!==holder||grant.term!==term||(grant.expiresAt??grant.expires_at)<=Date.now())throw Error('remote sidecar source fenced');if((await authority.request('/head',{})).home!==holder)throw Error('remote sidecar source is standby')}
 const run=fn=>{const job=queue.then(fn);queue=job.catch(()=>{});job.catch(()=>{});return job}
 async function initialize(){await owner();if(loadPending())throw Error('recover pending sidecar before initialization');const stage=mkdtempSync(join(dir,'initial-'));try{const proposed={};for(const component of Object.keys(files)){const row=await authority.request('/state/current',{component});if(sha(row.body)!==row.fileHash)throw Error('canonical sidecar body hash differs');writeFileSync(join(stage,files[component]),row.body,{mode:0o600});proposed[component]=row}const validators=adapters(stage,()=>{throw Error('initial verifier is read-only')});for(const component of Object.keys(files))if(!same(descriptor(component,validators[component],stage),proposed[component]))throw Error('canonical sidecar domain mismatch');await owner();for(const component of Object.keys(files)){const path=checked(join(dir,files[component]));if(existsSync(path)){if(sha(readFileSync(path))!==proposed[component].fileHash)throw Error('existing sidecar differs; use full generation recovery')}else atomic(path,proposed[component].body)}}finally{rmSync(stage,{recursive:true,force:true})}}
 async function recover(){await owner();const p=loadPending();if(!p)return {resolved:true,pending:false};if(p.format!=='remote-sidecar-pending-v1'||hash(p.request)!==p.requestHash||sha(p.request.body)!==p.afterHash)throw Error('pending sidecar journal changed');const status=await authority.request('/state/operation',{op:p.request.op});if(!status.found)return {resolved:false,pending:true};if(status.requestHash!==p.authorityRequestHash||status.fileHash!==p.afterHash||status.component!==p.request.component)throw Error('pending sidecar receipt conflict');const current=await authority.request('/state/current',{component:p.request.component}),path=checked(join(dir,files[p.request.component])),localHash=sha(readFileSync(path));if(current.fileHash===p.afterHash){if(localHash!==p.beforeHash&&localHash!==p.afterHash)throw Error('active sidecar changed during pending recovery');await owner();atomic(path,p.request.body)}else if(localHash!==current.fileHash)throw Error('canonical sidecar advanced; full generation recovery required');unlinkSync(checked(journal));return {resolved:true,replayed:true,result:p.result}}
 async function mutate(component,operation,planner){
  assertCognitiveActive();await owner();const op=getOperationId(component,operation),operationHash=hash(operation)
  const pending=loadPending();if(pending){if(pending.request.op!==op||pending.request.operationHash!==operationHash)throw Error('sidecar operation unresolved; recover before new writes');const recovered=await recover();if(!recovered.resolved)throw Error('sidecar operation unresolved; query before retry');return recovered.result}
  const existing=await authority.request('/state/operation',{op});if(existing.found){if(existing.component!==component||existing.operationHash!==operationHash||existing.holder!==holder)throw Error('sidecar operation replay conflict');const latest=await authority.request('/state/current',{component});if(descriptor(component).fileHash!==latest.fileHash)throw Error('sidecar replay requires current generation');return existing.result}
  const prior=descriptor(component),canonical=await authority.request('/state/current',{component});if(!same(prior,canonical))throw Error('local sidecar differs from authority; stop')
  const stage=mkdtempSync(join(dir,'plan-'));try{
   for(const name of Object.values(files))writeFileSync(join(stage,name),readFileSync(checked(join(dir,name))),{mode:0o600})
   const local=adapters(stage,fn=>fn()),result=await planner(local[component]),body=readFileSync(join(stage,files[component]),'utf8')
   if(sha(body)===prior.fileHash){await owner();return result}
   const next=descriptor(component,local[component],stage),expected={revision:prior.revision,digest:prior.digest,fileHash:prior.fileHash},request={op,term,component,expected,body,operationHash,result:result??null}
   const pending={format:'remote-sidecar-pending-v1',request,requestHash:hash(request),authorityRequestHash:hash({component,expected,bodyHash:next.fileHash,operationHash,resultHash:hash(result??null)}),beforeHash:prior.fileHash,afterHash:next.fileHash,result:result??null}
   assertCognitiveActive();atomic(journal,JSON.stringify(pending))
   try{await authority.request('/state/commit',request)}catch(error){throw Error('remote sidecar outcome unresolved; private plan retained',{cause:error})}
   const restored=await recover();if(!restored.resolved)throw Error('sidecar acceptance not confirmed');return result
  }finally{rmSync(stage,{recursive:true,force:true})}
 }
 const submit=(component,operation,planner)=>run(()=>mutate(component,operation,planner))
 const recallCounters=new Map(),json={...active.json,load:()=>{const state=active.json.load();for(const item of state.items)Object.assign(item,recallCounters.get(item.id)||{});return state},volatileRecall:true,recordRecall:state=>{for(const item of state.items)recallCounters.set(item.id,Object.fromEntries(['hits','lastHit','hitDays'].filter(k=>item[k]!==undefined).map(k=>[k,item[k]])))},save:state=>submit('json',{method:'save',state},store=>store.save(state)),runFeatureOperation:(method,args,factory)=>submit('json',{method,args},store=>factory(store)[method](...args))}
 const persona={...active.persona,savePersona:(id,value)=>submit('persona',{method:'savePersona',id,value},store=>store.savePersona(id,value))}
 const reads=new Set(['search','history','stats']),operations=Object.fromEntries(Object.keys(active.aiMemory.operations).map(method=>[method,reads.has(method)?(...args)=>active.aiMemory.operations[method](...args):(...args)=>submit('aiMemory',{method,args},store=>store.operations[method](...args))]))
 return {initialize:()=>run(initialize),recover:()=>run(recover),json,persona,aiMemory:{...active.aiMemory,operations},idle:()=>queue,pending:()=>{const p=loadPending();return p?{component:p.request.component,op:p.request.op}:null}}
}
