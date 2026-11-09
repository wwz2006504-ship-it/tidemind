// Synthetic stdio endpoint for a continuous two-host rehearsal; not a production service.
import {createInterface} from 'node:readline'
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {join,relative,isAbsolute} from 'node:path'
import {createWindowsRoundtrip,createCloudRoundtrip} from './roundtrip-fixture.mjs'
import {createAuthorityClient} from './authority-client.mjs'
import {dataRoot} from './fixture.mjs'
const args=process.argv.slice(2),send=value=>console.log('TIDEMIND_ROUNDTRIP '+JSON.stringify(value))
if(args.includes('--dry-run')||args.includes('--rollback'))send({dryRun:args.includes('--dry-run'),rollback:args.includes('--rollback'),productionEnabled:false,scope:'synthetic stdio processes only; EOF closes owned test state'})
else if(args[0]==='source'){
 const local=await createWindowsRoundtrip();let closing;const close=()=>closing??=local.cleanup()
 try{
  send({ready:true,port:Number(new URL(local.network.url).port),capsule:local.capsule})
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
   if(line.length>2*1024*1024)throw Error('bounded synthetic message required');const request=JSON.parse(line)
   if(request.command==='release-forward')send(await local.releaseForward(request.received))
   else if(request.command==='receive-return')send(await local.receiveReturn(request.payload,{loseReceiptResponse:request.loseReceiptResponse===true}))
   else if(request.command==='activate'){send(await local.activateReturned());break}
   else throw Error('unknown synthetic source operation')
  }
 }finally{await close()}
}else if(args[0]==='cloud'){
 mkdirSync(dataRoot,{recursive:true});const root=mkdtempSync(join(dataRoot,'roundtrip-cloud-'));process.env.TIDEMIND_SANDBOX_ROOT=root
 try{
  const authority=createAuthorityClient({url:args[1],token:'SYNTHETIC_CLOUD_TOKEN_987654321'});let cloud
  for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
   if(line.length>2*1024*1024)throw Error('bounded synthetic message required');const request=JSON.parse(line)
   if(request.command==='forward'&&!cloud){cloud=await createCloudRoundtrip({root,capsule:request.capsule,authority});send({passed:cloud.forward.passed,headDigest:cloud.forward.headDigest,receiptSubmissions:cloud.forward.receiptSubmissions})}
   else if(request.command==='advance'&&cloud)send(await cloud.advance({loseSigningResponse:request.loseSigningResponse===true}))
   else if(request.command==='finish'&&cloud)send(await cloud.finish(request.received,{loseHandoverResponse:request.loseHandoverResponse===true}))
   else if(request.command==='stop')break
   else throw Error('unknown synthetic cloud operation')
  }
 }finally{const rel=relative(realpathSync(dataRoot),realpathSync(root));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('unsafe synthetic cleanup');rmSync(root,{recursive:true,force:true})}
}else throw Error('explicit synthetic source or cloud mode required')
