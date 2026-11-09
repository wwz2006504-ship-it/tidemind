// Test-only stdio orchestration of the original authority/worker. Not a production entrypoint.
import {createInterface} from 'node:readline'
import {mkdirSync,mkdtempSync,rmSync,writeFileSync,readFileSync,realpathSync} from 'node:fs'
import {join,relative,isAbsolute} from 'node:path'
import assert from 'node:assert/strict'
import {createStateTransferFixture,slots,sha} from './state-transfer-fixture.mjs'
import {authorityHttpFixture} from './authority-http-fixture.mjs'
import {createAuthorityClient} from './authority-client.mjs'
import {receiveSyntheticState} from './state-transfer-receiver.mjs'
import {dataRoot} from './fixture.mjs'
const args=process.argv.slice(2),send=value=>console.log('TIDEMIND_STATE '+JSON.stringify(value))
if(args.includes('--dry-run')||args.includes('--rollback')){
 send({dryRun:args.includes('--dry-run'),rollback:args.includes('--rollback'),productionEnabled:false,scope:'synthetic-only; stdio EOF closes owned runtime and removes its synthetic scratch directory'})
}else if(args[0]==='source'){
 let f,network,closing
 const cleanup=()=>closing??=(async()=>{if(network)await network.cleanup();f?.cleanup()})()
 try{
  f=await createStateTransferFixture();network=await authorityHttpFixture({storageFixture:f})
  process.on('SIGTERM',()=>cleanup().catch(()=>{process.exitCode=1}))
  send({ready:true,port:Number(new URL(network.url).port),capsule:f.capsule})
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
   if(line.length>2*1024*1024)throw Error('bounded synthetic reply required')
   const result=JSON.parse(line);assert.equal(result.passed,true);assert.equal(result.headDigest,f.next.head.digest)
   const returned=join(f.root,'return-check');mkdirSync(returned)
   for(const n of slots){const bytes=Buffer.from(result.returnedFiles[n],'base64');assert.equal(sha(bytes),f.capsule.packet.files[n].after);writeFileSync(join(returned,n),bytes)}
   assert.equal(f.verify(returned).digest,f.next.head.digest);f.assertOriginals()
   const receipt=await network.local.request('/sync/status',{op:f.capsule.packet.op});assert.equal(receipt.accepted,true);assert.equal(receipt.headDigest,f.next.head.digest)
   assert.equal(f.gateway.head(f.lease).home,'local');assert.equal(f.lease.status().holder,'local')
   send({passed:true,sourceVerified:true,authorityReceiptAccepted:true,returnBytesMatch:true,revisions:Object.fromEntries(['sqlite','json','persona','aiMemory'].map(k=>[k,f.next.head[k].revision])),checks:result.checks,receiptSubmissions:result.receiptSubmissions,cloudNewWriteMerged:false,productionEnabled:false})
   break
  }
 }finally{await cleanup()}
}else if(args[0]==='receiver'){
 mkdirSync(dataRoot,{recursive:true});const root=mkdtempSync(join(dataRoot,'cross-state-receiver-'));process.env.TIDEMIND_SANDBOX_ROOT=root
 try{
  const authority=createAuthorityClient({url:args[1],token:'SYNTHETIC_CLOUD_TOKEN_987654321'})
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
   if(line.length>2*1024*1024)throw Error('bounded synthetic capsule required')
   send(await receiveSyntheticState({root,capsule:JSON.parse(line),authority,loseReceiptResponse:args.includes('--lose-receipt-response')}));break
  }
 }finally{const rel=relative(realpathSync(dataRoot),realpathSync(root));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('unsafe synthetic cleanup');rmSync(root,{recursive:true,force:true})}
}else throw Error('explicit synthetic source or receiver mode required')
