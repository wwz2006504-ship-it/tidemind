// Portable synthetic four-adapter fixture. Never accepts a production source path.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {fixture} from './fixture.mjs'
import {createIdentityBinding} from './identity-binding.mjs'
import {createPersonaVersions} from './persona-versions.mjs'
import {createProtectedJsonMemory} from './protected-json-memory.mjs'
import {createProtectedAiMemory} from './protected-ai-memory.mjs'
import {createGenerationVerifier} from './generation-verifier.mjs'
import {createReplicaGenerations} from './replica-generation.mjs'
import {prepareStoreOperation} from './store-adapter.mjs'
import {createSyncDelta} from './sync-delta.mjs'
export const slots=['memory.db','new-memories.json','persona-versions.json','ledger.jsonl']
export const secret='SYNTHETIC CROSS STATE SYNC SECRET 123456789'
export const sha=b=>createHash('sha256').update(b).digest('hex')
export const syntheticOriginals={persona:'---\nname: SYNTHETIC\ntags: []\n---\nSYNTHETIC STATE TRANSFER IDENTITY\n',json:JSON.stringify({items:[{id:'original-json',text:'SYNTHETIC ORIGINAL JSON'}]}),ai:JSON.stringify({seq:1,at:1,type:'node.created',data:{id:'original-ai',kind:'insight',text:'SYNTHETIC ORIGINAL AI'}})+'\n'}
export function setupOriginals(root){
 const source=join(root,'synthetic-originals');mkdirSync(source);mkdirSync(join(source,'personas'))
 writeFileSync(join(source,'personas/synthetic.md'),syntheticOriginals.persona);writeFileSync(join(source,'memories.json'),syntheticOriginals.json);writeFileSync(join(source,'ai-original.jsonl'),syntheticOriginals.ai)
 const pins={persona:sha(syntheticOriginals.persona),jsonMemory:sha(syntheticOriginals.json)}
 return {source,pins,verify:createGenerationVerifier({ownedRoot:root,sourceDataRoot:source,selectedPersona:'synthetic',pins,aiSource:join(source,'ai-original.jsonl'),aiBaselineSha256:sha(syntheticOriginals.ai)})}
}
export async function createStateTransferFixture(){
 const f=await fixture();try{
  const {source,pins,verify}=setupOriginals(f.root),side=join(f.root,'sidecars'),generations=join(f.root,'generations');mkdirSync(side);mkdirSync(generations)
  const guard=fn=>f.lease.fenced('local',f.term,fn)
  const identity=createPersonaVersions({identity:createIdentityBinding({directory:join(source,'personas'),selected:'synthetic',expectedSha256:pins.persona}),ownedRoot:f.root,stateFile:join(side,'persona-versions.json'),withWriteGuard:guard})
  const json=createProtectedJsonMemory({source:join(source,'memories.json'),expectedSha256:pins.jsonMemory,overlay:join(side,'new-memories.json'),ownedRoot:f.root,withWriteGuard:guard})
  const ai=createProtectedAiMemory({source:join(source,'ai-original.jsonl'),baselineSha256:sha(syntheticOriginals.ai),ownedRoot:f.root,directory:side,withWriteGuard:guard})
  const append=label=>{const memory=json.load();memory.items.push({id:'json-'+label,text:'SYNTHETIC '+label});json.save(memory);const p=identity.readPersona();identity.savePersona(p.id,{...p,body:p.body+' SYNTHETIC '+label});ai.operations.write({kind:'insight',text:'SYNTHETIC '+label})}
  const files={'memory.db':f.local,...Object.fromEntries(slots.slice(1).map(n=>[n,join(side,n)]))},store=createReplicaGenerations({directory:generations,verifyGeneration:verify})
  // First create a fully materialized baseline; no absent-sidecar placeholders.
  append('base');const baselineProbe=join(f.root,'baseline-probe');mkdirSync(baselineProbe)
  // The source composite is read through the actual adapters, using a consistent SQLite backup.
  const {DatabaseSync,backup}=await import('node:sqlite');const db=new DatabaseSync(f.local,{readOnly:true});try{await backup(db,join(baselineProbe,'memory.db'))}finally{db.close()}
  for(const n of slots.slice(1))writeFileSync(join(baselineProbe,n),readFileSync(files[n]))
  const base=await store.prepare({sourceFiles:files,head:verify(baselineProbe)})
  const old=f.gateway.head(f.lease),op='cross-state-sql'
  const planned=await prepareStoreOperation(f.local,{method:'write',args:[{layer:'semantic',content:'SYNTHETIC CROSS MACHINE NEW SQLITE',source:'tool'}],now:2},{MemoryStore:f.MemoryStore,commitContext:{op,holder:'local',term:f.term,revision:old.revision,hash:old.hash}})
  f.gateway.commit(f.lease,'local',f.term,{op,expectedRevision:old.revision,expectedHash:old.hash,mutation:planned.batch})
  f.replica.materialize(f.local,f.gateway.committedSince(f.lease,old.revision),{expected:f.replica.replicaHead(f.local),sourceHead:f.gateway.head(f.lease),home:'local'})
  append('next');const nextProbe=join(f.root,'next-probe');mkdirSync(nextProbe);const db2=new DatabaseSync(f.local,{readOnly:true});try{await backup(db2,join(nextProbe,'memory.db'))}finally{db2.close()};for(const n of slots.slice(1))writeFileSync(join(nextProbe,n),readFileSync(files[n]))
  const next=await store.prepare({sourceFiles:files,head:verify(nextProbe)})
  const packet=createSyncDelta({baseDirectory:base.directory,nextDirectory:next.directory,baseHead:base.head,nextHead:next.head,op:'cross-state-forward',holder:'local',term:f.term,target:'cloud',secret,withSourceFence:({holder,term},fn)=>f.lease.fenced(holder,term,fn),readCurrentComposite:()=>verify(nextProbe)})
  const conflictPacket=createSyncDelta({baseDirectory:base.directory,nextDirectory:next.directory,baseHead:base.head,nextHead:next.head,op:'cross-state-stale-target',holder:'local',term:f.term,target:'cloud',secret,withSourceFence:({holder,term},fn)=>f.lease.fenced(holder,term,fn),readCurrentComposite:()=>verify(nextProbe)})
  const capsule={format:'synthetic-four-adapter-capsule-v1',baseHead:base.head,nextHead:next.head,baseFiles:Object.fromEntries(slots.map(n=>[n,readFileSync(join(base.directory,n)).toString('base64')])),packet,conflictPacket}
  return {...f,base,next,verify,capsule,assertOriginals:()=>{if(readFileSync(join(source,'personas/synthetic.md'),'utf8')!==syntheticOriginals.persona||readFileSync(join(source,'memories.json'),'utf8')!==syntheticOriginals.json||readFileSync(join(source,'ai-original.jsonl'),'utf8')!==syntheticOriginals.ai)throw Error('synthetic originals changed')}}
 }catch(e){f.cleanup();throw e}
}
