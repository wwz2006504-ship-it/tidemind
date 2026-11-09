import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {DatabaseSync,backup} from 'node:sqlite'
import {createStateTransferFixture,sha,syntheticOriginals} from './state-transfer-fixture.mjs'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {createRemoteSidecars} from './remote-sidecars.mjs'
import {createPersonaVersions} from './persona-versions.mjs'
import {createIdentityBinding} from './identity-binding.mjs'
import {remoteOperationId,wrapRemoteOperationTool} from './remote-operation-scope.mjs'
import {createMemoryStore} from '../host/aurabot/src/features/memory.js'
async function setup(){const f=await createStateTransferFixture(),source=join(f.root,'synthetic-originals'),spec={sqlBaselineFile:join(f.base.directory,'memory.db'),sourceDataRoot:source,selectedPersona:'synthetic',pins:{persona:sha(syntheticOriginals.persona),jsonMemory:sha(syntheticOriginals.json)},aiSource:join(source,'ai-original.jsonl'),aiBaselineSha256:sha(syntheticOriginals.ai)};let network;try{network=await authorityHttpFixture({storageFixture:f,stateSpec:spec});const directory=join(f.root,'remote-sidecars'),journalDirectory=join(f.root,'sidecar-pending');mkdirSync(directory);mkdirSync(journalDirectory);let counter=0;const client=authority=>createRemoteSidecars({authority:authority||network.local,holder:'local',term:f.term,ownedRoot:f.root,directory,journalDirectory,spec,getOperationId:()=> 'sidecar-op-'+(++counter)});return {...f,network,spec,directory,journalDirectory,client,cleanup:async()=>{await network.cleanup();f.cleanup()}}}catch(e){if(network)await network.cleanup();f.cleanup();throw e}}
test('all three original sidecar operations await one remote authority and match its four-store frontier',async()=>{const f=await setup();try{const client=f.client();await client.initialize();const memory=client.json.load();memory.items.push({id:'remote-new',text:'SYNTHETIC REMOTE JSON'});await client.json.save(memory);const p=client.persona.readPersona();await client.persona.savePersona(p.id,{...p,body:p.body+' SYNTHETIC REMOTE PERSONA'});await client.aiMemory.operations.write({kind:'insight',text:'SYNTHETIC REMOTE AI'});assert.equal(client.pending(),null)
 const db=new DatabaseSync(f.local,{readOnly:true});try{await backup(db,join(f.directory,'memory.db'))}finally{db.close()}
 assert.deepEqual(f.verify(f.directory),await f.network.local.request('/state/head',{}));f.assertOriginals()
}finally{await f.cleanup()}})
test('lost sidecar acceptance response keeps active file unchanged until query-only recovery',async()=>{const f=await setup();try{let commits=0;const client=f.client({request:async(path,body)=>{const value=await f.network.local.request(path,body);if(path==='/state/commit'){commits++;throw Error('SYNTHETIC RESPONSE LOST')}return value}});await client.initialize();const before=readFileSync(join(f.directory,'new-memories.json')),state=client.json.load();state.items.push({id:'lost-new',text:'SYNTHETIC LOST ACK'});await assert.rejects(client.json.save(state),/unresolved/);assert.deepEqual(readFileSync(join(f.directory,'new-memories.json')),before);assert.equal(client.pending().component,'json');assert.equal((await client.recover()).resolved,true);assert.equal(commits,1);assert.ok(client.json.load().items.some(x=>x.id==='lost-new'));f.assertOriginals()}finally{await f.cleanup()}})
test('stale JSON save and changes to original records stop without overwriting accepted state',async()=>{const f=await setup();try{const client=f.client();await client.initialize();const stale=client.json.load(),state=client.json.load();state.items.push({id:'first',text:'SYNTHETIC FIRST'});await client.json.save(state);await assert.rejects(client.json.save(stale),/revision conflict/);const original=client.json.load();original.items.find(x=>x.id==='original-json').text='FORBIDDEN';await assert.rejects(client.json.save(original),/protected original/);assert.equal((await f.network.local.request('/state/current',{component:'json'})).revision,1);f.assertOriginals()}finally{await f.cleanup()}})
test('authority rejects a valid-looking persona fork and blocked memory writes',async()=>{const f=await setup();try{const client=f.client();await client.initialize();const p=client.persona.readPersona();await client.persona.savePersona(p.id,{...p,body:p.body+' ACCEPTED'});const current=await f.network.local.request('/state/current',{component:'persona'}),branch=join(f.root,'valid-branch');mkdirSync(branch)
 const persona=createPersonaVersions({identity:createIdentityBinding({directory:join(f.spec.sourceDataRoot,'personas'),selected:'synthetic',expectedSha256:f.spec.pins.persona}),ownedRoot:f.root,stateFile:join(branch,'persona-versions.json'),withWriteGuard:fn=>fn()});persona.savePersona(p.id,{...p,body:p.body+' BRANCH ONE'});persona.savePersona(p.id,{...p,body:p.body+' BRANCH TWO'})
 await assert.rejects(f.network.local.request('/state/commit',{op:'fork',operationHash:hash('valid-fork-test'),term:f.term,component:'persona',expected:{revision:current.revision,digest:current.digest,fileHash:current.fileHash},body:readFileSync(join(branch,'persona-versions.json'),'utf8')}),e=>e.status===409)
 await f.network.local.request('/transfer/freeze',{op:'freeze-sidecars',term:f.term});await assert.rejects(client.aiMemory.operations.write({kind:'insight',text:'SYNTHETIC BLOCKED'}),/unresolved/);assert.equal((await f.network.local.request('/state/current',{component:'aiMemory'})).revision,0);f.assertOriginals()
}finally{await f.cleanup()}})
test('stable tool identity replays original AI-memory result after client reconstruction',async()=>{const f=await setup();try{
 const make=()=>createRemoteSidecars({authority:f.network.local,holder:'local',term:f.term,ownedRoot:f.root,directory:f.directory,journalDirectory:f.journalDirectory,spec:f.spec,getOperationId:remoteOperationId})
 let client=make();await client.initialize()
 const tool=()=>wrapRemoteOperationTool({name:'memory_write',execute:args=>client.aiMemory.operations.write(args)})
 const exec={agent:{id:'synthetic-agent',session:{id:'synthetic-agent'},turn:1},callId:'stable-original-call'}
 const args={kind:'insight',text:'SYNTHETIC STABLE ORIGINAL TOOL'}
 const first=await tool().execute(args,exec),head=await f.network.local.request('/state/current',{component:'aiMemory'})
 client=make();await client.initialize();assert.deepEqual(await tool().execute(args,exec),first)
 await assert.rejects(tool().execute({...args,text:'SYNTHETIC CHANGED SAME CALL'},exec),/replay conflict/)
 assert.equal((await f.network.local.request('/state/current',{component:'aiMemory'})).revision,head.revision)
 f.assertOriginals()
}finally{await f.cleanup()}})
test('remote tool wrapper refuses calls without original execution identity',()=>{
 const tool=wrapRemoteOperationTool({name:'memory_write',execute:()=>assert.fail('must not run')})
 assert.throws(()=>tool.execute({},{}),/identity required/)
})
test('original Aurabot memory feature awaits remote commit and recall remains read-only',async()=>{const f=await setup();try{
 const client=f.client();await client.initialize()
 const memory=createMemoryStore({storage:client.json,getConfig:()=>({memory:{recallCount:6}})})
 const added=await memory.add({text:'SYNTHETIC 天文望远镜 REMOTE FEATURE',importance:.7})
 assert.equal(added.ok,true);assert.ok(memory.list().some(x=>x.id===added.id))
 const before=await f.network.local.request('/state/current',{component:'json'})
 assert.ok(memory.recall('天文望远镜').some(x=>x.it.id===added.id))
 assert.equal((await f.network.local.request('/state/current',{component:'json'})).fileHash,before.fileHash)
 assert.equal((await memory.update(added.id,{text:'SYNTHETIC UPDATED FEATURE'})).ok,true)
 assert.equal((await memory.remove(added.id)).ok,true);assert.ok(!memory.list().some(x=>x.id===added.id))
 f.assertOriginals()
}finally{await f.cleanup()}})
