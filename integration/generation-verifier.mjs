// Reopen candidates through the original adapters; parsing JSON alone is not sufficient.
import {join} from 'node:path'
import {replicaHead} from '../TideMind/deploy/existing/tide-replica.mjs'
import {createIdentityBinding} from './identity-binding.mjs'
import {createPersonaVersions} from './persona-versions.mjs'
import {createProtectedJsonMemory} from './protected-json-memory.mjs'
import {createProtectedAiMemory} from './protected-ai-memory.mjs'
import {createCompositeHead} from './composite-head.mjs'
export function createGenerationVerifier({ownedRoot,sourceDataRoot,selectedPersona,pins,aiSource,aiBaselineSha256}){
 const readonly=()=>{throw Error('candidate verifier is read-only')}
 return directory=>{
  const identity=createIdentityBinding({directory:join(sourceDataRoot,'personas'),selected:selectedPersona,expectedSha256:pins.persona})
  const persona=createPersonaVersions({identity,ownedRoot,stateFile:join(directory,'persona-versions.json'),withWriteGuard:readonly})
  const json=createProtectedJsonMemory({source:join(sourceDataRoot,'memories.json'),expectedSha256:pins.jsonMemory,overlay:join(directory,'new-memories.json'),ownedRoot,withWriteGuard:readonly})
  const ai=createProtectedAiMemory({source:aiSource,baselineSha256:aiBaselineSha256,ownedRoot,directory,withWriteGuard:readonly})
  return createCompositeHead({sqlite:replicaHead(join(directory,'memory.db')),jsonMemory:json.inspect(),persona:persona.inspect(),aiMemory:ai.inspect()})
 }
}
