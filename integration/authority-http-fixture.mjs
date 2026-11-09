import {fixture} from './fixture.mjs'
import {serveAuthority} from '../TideMind/deploy/existing/tide-authority.mjs'
import {createAuthorityClient} from './authority-client.mjs'
import {createCompositeHead} from './composite-head.mjs'
const h='a'.repeat(64),keys={local:'SYNTHETIC LOCAL MATERIALIZER KEY 1234567',cloud:'SYNTHETIC CLOUD MATERIALIZER KEY 7654321'},tokens={local:'SYNTHETIC_LOCAL_TOKEN_123456789',cloud:'SYNTHETIC_CLOUD_TOKEN_987654321'}
export async function authorityHttpFixture({withKeys=true,standby=false,storageFixture,stateSpec,qqConfig,taskConfig}={}){
 const f=storageFixture||await fixture(),sqlite=f.replica.replicaHead(f.local),composite=createCompositeHead({sqlite,jsonMemory:{overlayRevision:0,overlayHash:h,baselineSha256:h},persona:{overlayVersion:0,currentHash:h,sha256:h},aiMemory:{revision:0,hash:h,baseline:h}}),ack={...sqlite,composite}
 const values={TIDEMIND_LOCAL_TOKEN:tokens.local,TIDEMIND_CLOUD_TOKEN:tokens.cloud,TIDEMIND_PROTECTED_IDS:JSON.stringify([f.core.id]),TIDEMIND_BASELINE_DATA_HASH:sqlite.baseline_hash,TIDEMIND_BASELINE_PROTECTED_HASH:sqlite.protected_hash,TIDEMIND_LOCAL_MATERIALIZER_KEY:withKeys?keys.local:undefined,TIDEMIND_CLOUD_MATERIALIZER_KEY:withKeys?keys.cloud:undefined,TIDEMIND_AUTHORITY_STANDBY:standby?'1':'0',TIDEMIND_REQUIRE_SOURCE_GATE:process.env.TIDEMIND_REQUIRE_SOURCE_GATE,TIDEMIND_REQUIRE_MEMORY_BARRIER:process.env.TIDEMIND_REQUIRE_MEMORY_BARRIER,TIDEMIND_REQUIRE_QQ_BINDING:process.env.TIDEMIND_REQUIRE_QQ_BINDING,TIDEMIND_REQUIRE_COMPOSITE_HANDOVER:process.env.TIDEMIND_REQUIRE_COMPOSITE_HANDOVER,TIDEMIND_REQUIRE_HANDOVER_TICKET:process.env.TIDEMIND_REQUIRE_HANDOVER_TICKET}
 const before=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));for(const [k,v]of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v
 let server
 try{server=serveAuthority(f.lease,{port:0,stateSpec,qqConfig,taskConfig});await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/'
  let closing
  const cleanup=()=>closing??=(async()=>{await server.closeCapabilities();server.closeAllConnections();await new Promise(r=>server.close(r));for(const [k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;if(!storageFixture)f.cleanup()})()
  return {...f,ack,url,local:createAuthorityClient({url,token:tokens.local}),cloud:createAuthorityClient({url,token:tokens.cloud}),cleanup}
 }catch(e){for(const [k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;if(!storageFixture)f.cleanup();throw e}
}

export {keys,tokens}
