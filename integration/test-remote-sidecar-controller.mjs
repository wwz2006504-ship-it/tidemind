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
import {controllerHost} from './controller-host.mjs'
import {mountRemoteSidecarTools} from './remote-sidecar-tools.mjs'
test('real Controller executes original remember, persona_edit and memory_write through remote authority',async()=>{const f=await setup();let host,unmount;try{
 const calls=[{id:'real-json',name:'remember',args:{text:'SYNTHETIC CONTROLLER JSON'}},{id:'real-persona',name:'persona_edit',args:{new_text:'SYNTHETIC CONTROLLER PERSONA'}},{id:'real-ai',name:'memory_write',args:{kind:'insight',text:'SYNTHETIC CONTROLLER AI'}}]
 const remote=createRemoteSidecars({authority:f.network.local,holder:'local',term:f.term,ownedRoot:f.root,directory:f.directory,journalDirectory:f.journalDirectory,spec:f.spec,getOperationId:remoteOperationId});await remote.initialize()
 host=await controllerHost({storageFixture:{...f,cleanup:()=>{}},mountMemory:false,mode:'scripted-tools',scriptedCalls:calls});unmount=mountRemoteSidecarTools(host,remote)
 host.agent.followup({id:'synthetic-remote-sidecar-turn',role:'user',content:[{type:'text',text:'SYNTHETIC ONLY'}],source:{kind:'plugin'}})
 let ended=false;for(let i=0;i<1000;i++){ended=host.agent.status==='idle'&&host.agent.session.snapshotEvents().some(e=>e.type==='turn/end');if(ended)break;await new Promise(r=>setTimeout(r,5))}
 assert.equal(ended,true);await remote.idle();assert.deepEqual(host.errors,[]);assert.equal(host.requests.length,4)
 assert.ok(remote.json.load().items.some(x=>x.text==='SYNTHETIC CONTROLLER JSON'))
 assert.match(remote.persona.readPersona().body,/SYNTHETIC CONTROLLER PERSONA/)
 assert.match(readFileSync(join(f.directory,'ledger.jsonl'),'utf8'),/SYNTHETIC CONTROLLER AI/)
 assert.equal(remote.pending(),null);f.assertOriginals()
}finally{if(unmount)unmount();if(host)await host.cleanup();await f.cleanup()}})
