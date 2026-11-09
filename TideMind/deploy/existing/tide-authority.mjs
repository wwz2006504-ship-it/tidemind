import {createSourceAdmission} from '../../../integration/source-admission.mjs'
import {createMemoryBarrier} from '../../../integration/memory-barrier.mjs'
// Transport for lease.mjs, bound to loopback. Remote hosts use an authenticated
// private tunnel; clients do not share SQLite files or receive QQ credentials.
import http from 'node:http'
import {timingSafeEqual} from 'node:crypto'
import * as gateway from './tide-gateway.mjs'
import {createSyncReceipts} from '../../../integration/sync-receipts.mjs'
import {signSealedReverseDelta} from '../../../integration/sync-delta.mjs'
import {createSidecarAuthority} from '../../../integration/sidecar-authority.mjs'
import {createQQAuthority} from '../../../integration/qq-authority.mjs'
import {createTaskAuthority} from '../../../integration/task-authority.mjs'
import {inspectAuthorityQuiet} from '../../../integration/authority-quiet.mjs'
import {createSessionHistoryAuthority,assertCanonicalFourFrontier} from '../../../integration/session-history-authority.mjs'
import {readFileSync,realpathSync} from 'node:fs'
import {relative,isAbsolute} from 'node:path'
export function serveAuthority(lease,{port=Number(process.env.TIDEMIND_AUTHORITY_PORT||5181),stateSpec,qqConfig,taskConfig,historyConfig,requireHome=false,transportReadiness}={}) {
 if(process.env.TIDEMIND_ALLOW_LEGACY_SYNTHETIC!=='1'){
  process.env.TIDEMIND_REQUIRE_STORE_PROOF='1'
  process.env.TIDEMIND_REQUIRE_QQ_BINDING='1'
  process.env.TIDEMIND_REQUIRE_HANDOVER_TICKET='1'
  process.env.TIDEMIND_REQUIRE_COMPOSITE_HANDOVER='1'
  process.env.TIDEMIND_REQUIRE_MEMORY_BARRIER='1'
  process.env.TIDEMIND_REQUIRE_SOURCE_GATE='1'
  if((process.env.TIDEMIND_STORE_SIGNING_KEY||'').length<32)throw new Error('trusted store signing key required')
 }
 const tokens={local:process.env.TIDEMIND_LOCAL_TOKEN,cloud:process.env.TIDEMIND_CLOUD_TOKEN}
 if(!tokens.local||!tokens.cloud||tokens.local===tokens.cloud)throw new Error('distinct principal credentials required')
 gateway.initialize(lease,{protectedIds:JSON.parse(process.env.TIDEMIND_PROTECTED_IDS||'null'),baseline:{data_hash:process.env.TIDEMIND_BASELINE_DATA_HASH,protected_hash:process.env.TIDEMIND_BASELINE_PROTECTED_HASH}})
 const materializerKeys={local:process.env.TIDEMIND_LOCAL_MATERIALIZER_KEY,cloud:process.env.TIDEMIND_CLOUD_MATERIALIZER_KEY}
 if(Boolean(materializerKeys.local)!==Boolean(materializerKeys.cloud))throw Error('both distinct materializer keys required')
 const receipts=materializerKeys.local?createSyncReceipts({lease,materializerKeys}):null
 if(!stateSpec&&process.env.TIDEMIND_STATE_SPEC){const root=realpathSync(process.env.TIDEMIND_SANDBOX_ROOT),path=realpathSync(process.env.TIDEMIND_STATE_SPEC),r=relative(root,path);if(!r||r.startsWith('..')||isAbsolute(r))throw Error('state spec outside owned authority');stateSpec=JSON.parse(readFileSync(path,'utf8'))}
 const sidecars=stateSpec?createSidecarAuthority({lease,spec:stateSpec}):null
 const qq=qqConfig?createQQAuthority({lease,config:qqConfig,historyKeys:materializerKeys}):null
 const tasks=taskConfig?createTaskAuthority({lease,config:taskConfig}):null
 const histories=sidecars&&materializerKeys.local?createSessionHistoryAuthority({lease,keys:materializerKeys,initialDigest:historyConfig?.initialDigest||process.env.TIDEMIND_HISTORY_INITIAL_DIGEST,initialBundle:historyConfig?.initialBundle,currentFourHead:sidecars.composite}):null
 let custody
 function clearCustody(){clearInterval(custody?.timer);custody=undefined}
 function retainTransfer(holder,term,op){
  if(typeof op!=='string'||!op||op.length>160)throw Error('bounded transfer operation required')
  function checkSource(){
   const source=createSourceAdmission({lease,holder,term}).status()
   if(source.state!=='paused'||source.op!==op||source.holder!==holder||source.term!==term||!inspectAuthorityQuiet({lease,holder,term}).quiet)throw Error('matching drained source pause required')
  }
  function renew(deadline){
   checkSource()
   const ttl=Math.min(60000,deadline-Date.now())
   if(ttl<=0)throw Error('controller custody window elapsed')
   const receipt=lease.renew(holder,term,{ttl})
   if(!receipt.ok)throw Error('controller cannot renew source lease')
   return receipt
  }
  if(custody){
   if(custody.holder!==holder||custody.term!==term||custody.op!==op)throw Error('another transfer owns controller custody')
   checkSource()
   if(Date.now()>=custody.deadline)throw Error('controller custody window elapsed')
   return {...custody.receipt,deadline:custody.deadline,replayed:true}
  }
  checkSource()
  const deadline=Date.now()+120000
  lease.fenced(holder,term,db=>{
   const prior=db.prepare('SELECT 1 FROM tide_transfer_custody WHERE term=? AND op=?').get(term,op)
   if(prior)throw Error('previous controller custody requires recovery review')
   db.prepare('INSERT INTO tide_transfer_custody(term,op,holder,deadline) VALUES(?,?,?,?)').run(term,op,holder,deadline)
  })
  const receipt=renew(deadline)
  const timer=setInterval(()=>{try{custody.receipt=renew(deadline)}catch{clearCustody()}},15000)
  timer.unref()
  custody={holder,term,op,deadline,receipt,timer}
  return {...receipt,deadline,replayed:false}
 }
 const principal=req=>{
  const given=Buffer.from(req.headers.authorization||'')
  return Object.entries(tokens).find(([,token])=>{
   const expected=Buffer.from('Bearer '+token)
   return given.length===expected.length&&timingSafeEqual(given,expected)
  })?.[0]
 }
 const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data))}
  const holder=principal(req)
  if(!holder)return send(401,{ok:false,reason:'unauthorized'})
  if(req.method!=='POST')return send(404,{ok:false})
  let text=''
  try {
   for await(const c of req){text+=c;if(Buffer.byteLength(text)>(req.url==='/sync/history/publish'?33*1024*1024:req.url==='/state/commit'?4*1024*1024:65536))return send(413,{ok:false})}
   const body=JSON.parse(text||'{}')
   if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('invalid request')
   const dispatch=async()=>{
   if(process.env.TIDEMIND_AUTHORITY_STANDBY==='1' && !['/head','/entries'].includes(req.url) && !(req.url==='/admin'&&body.command==='status'))return send(423,{ok:false,reason:'installation-not-activated'})
   if(req.url==='/admin') {
    const command=body.command
    const out=command==='acquire'?lease.acquire(holder,{ttl:Math.min(60000,Math.max(100,Number(body.ttl)||60000)),requireHome}):
     command==='renew'?lease.renew(holder,body.term):command==='release'?lease.release(holder,body.term):
     command==='status'?lease.status():null
    if(!out)return send(400,{ok:false})
    return send(200,out)
   }
   if(req.url==='/head')return send(200,gateway.head(lease))
   if(req.url==='/activation/status'){
    if(!requireHome||!sidecars||!qq||!tasks||!histories||!historyConfig?.initialBundle||
       typeof transportReadiness!=='function'||(process.env.TIDEMIND_SYNC_SIGNING_KEY||'').length<32){
     return send(423,{ok:false,reason:'production-wiring-incomplete'})
    }
    const head=gateway.head(lease),stores=sidecars.composite(),history=histories.current()
    return send(200,{head,storeDigest:stores.digest,historyDigest:history.found?history.head.digest:historyConfig.initialDigest,
      historyPublished:history.found,lease:lease.status(),gateways:transportReadiness()})
   }
   if(req.url.startsWith('/qq/')){if(!qq)return send(423,{ok:false,reason:'qq-authority-not-configured'});return send(200,await qq.request(holder,req.url,body))}
   if(req.url.startsWith('/task/')){if(!tasks)return send(423,{ok:false,reason:'task-authority-not-configured'});return send(200,await tasks.request(holder,req.url,body))}
   if(req.url.startsWith('/state/')){
    if(!sidecars)return send(423,{ok:false,reason:'state-authority-not-configured'})
    if(req.url==='/state/current')return send(200,sidecars.current(body.component))
    if(req.url==='/state/operation')return send(200,sidecars.status(body.op))
    if(req.url==='/state/head')return send(200,sidecars.composite())
    if(req.url==='/state/commit')return send(200,sidecars.commit(holder,body.term,body))
   }
   if(req.url==='/operation'){
    if(typeof body.op!=='string'||!body.op||body.op.length>200)throw Error('bounded operation required')
    const db=lease.openAuthority();try{const row=db.prepare('SELECT revision,op,term,holder,hash,payload FROM tide_log WHERE op=?').get(body.op)
     if(!row)return send(200,{found:false,op:body.op})
     const mutation=JSON.parse(row.payload);return send(200,{found:true,op:row.op,revision:row.revision,term:row.term,holder:row.holder,hash:row.hash,requestHash:mutation.requestHash,result:mutation.storeResult})
    }finally{db.close()}
   }
   if(req.url==='/entries')return send(200,{entries:gateway.committedSince(lease,Number(body.after)||0)})
   if(req.url==='/commit')return send(200,gateway.commit(lease,holder,body.term,body))
   if(req.url==='/enqueue')return send(200,gateway.enqueue(lease,holder,body.term,body))
   if(req.url.startsWith('/sync/')||req.url.startsWith('/transfer/')){
    if(!receipts)return send(423,{ok:false,reason:'materializer-keys-not-configured'})
    if(req.url==='/sync/history/current'){if(!histories)throw Error('history authority unavailable');return send(200,histories.current())}
    if(req.url==='/sync/history/publish'){if(!histories)throw Error('history authority unavailable');return send(200,histories.publish(holder,body.term,body))}
    if(req.url==='/sync/sign'){
     const secret=process.env.TIDEMIND_SYNC_SIGNING_KEY
     if(typeof secret!=='string'||secret.length<32)return send(423,{ok:false,reason:'sync-signing-not-configured'})
     return send(200,signSealedReverseDelta({lease,principal:holder,body:body.descriptor,ticketId:body.ticketId,secret,authorizeHandover:proof=>receipts.authorizeReverse({ticketId:body.ticketId,...proof})}))
    }
    if(req.url==='/sync/check')return send(200,receipts.checkSource({principal:holder,holder:body.holder,term:body.term,target:body.target,mode:body.mode,baseDigest:body.baseDigest,head:body.head,historyHead:body.historyHead,ticketId:body.ticketId,op:body.op,sealed:body.sealed===true}))
    if(req.url==='/sync/receipt'){
     if(body.receipt?.target!==holder)return send(403,{ok:false,reason:'receiver-principal-required'})
     return send(200,receipts.accept(body.receipt))
    }
    if(req.url==='/sync/status')return send(200,receipts.status({principal:holder,op:body.op}))
    if(req.url==='/transfer/pause')return send(200,createSourceAdmission({lease,holder,term:body.term}).pause(body.op))
    if(req.url==='/transfer/retain')return send(200,retainTransfer(holder,body.term,body.op))
    if(req.url==='/transfer/status')return send(200,lease.fenced(holder,body.term,db=>({...db.prepare('SELECT * FROM tide_memory_barrier WHERE id=1').get()})))
    if(req.url==='/transfer/quiet')return send(200,inspectAuthorityQuiet({lease,holder,term:body.term}))
    if(req.url==='/transfer/resume-input'){
     const result=createSourceAdmission({lease,holder,term:body.term}).resume(body.op)
     if(custody?.holder===holder&&custody.term===body.term&&custody.op===body.op)clearCustody()
     return send(200,result)
    }
    if(req.url==='/transfer/freeze')return send(200,createMemoryBarrier({lease,holder,term:body.term}).begin(body.op))
    if(req.url==='/transfer/seal'){
     const canonical=sidecars?.composite(),s=body.head?.sqlite
     return send(200,lease.fenced(holder,body.term,db=>createMemoryBarrier({lease,holder,term:body.term}).seal(body.op,()=>{if(sidecars){if(canonical.digest!==body.head?.digest)throw Error('canonical sidecar frontier differs');assertCanonicalFourFrontier(db,{revision:s?.revision,hash:s?.hash,data_hash:s?.dataHash,baseline_hash:s?.baseline,protected_hash:s?.protectedHash,composite:body.head})}return body.head})))
    }
    if(req.url==='/transfer/resume')return send(200,createMemoryBarrier({lease,holder,term:body.term}).resume(body.op))
    if(req.url==='/transfer/begin')return send(200,receipts.begin({holder,term:body.term,op:body.op,target:body.target,baseDigest:body.baseDigest,sourceAck:body.sourceAck}))
    if(req.url==='/transfer/confirm')return send(200,receipts.confirm({holder,term:body.term,ticketId:body.ticketId,receiptOp:body.receiptOp,sourceAck:body.sourceAck}))
    if(req.url==='/transfer/authorize'){
     if(![body.holder,body.target].includes(holder))return send(403,{ok:false,reason:'transfer-principal-required'})
     return send(200,receipts.authorizeReverse({ticketId:body.ticketId,holder:body.holder,term:body.term,target:body.target,baseDigest:body.baseDigest,nextDigest:body.nextDigest}))
    }
    if(req.url==='/transfer/handover'){
     if(typeof body.ticketId!=='string'||!body.ticketId)return send(409,{ok:false,reason:'reviewed-ticket-required'})
     return send(200,gateway.handover(lease,holder,body.term,{...body}))
    }
   }
   return send(404,{ok:false})
   }
   if(body.activity!==undefined&&!req.url.startsWith('/task/')){
    if(!tasks)throw Error('original activity authority unavailable')
    return await tasks.withActivity(holder,body.term,body.activity,dispatch)
   }
   return await dispatch()
  }catch{return send(409,{ok:false,reason:'rejected'})}
 })
 server.requestTimeout=3000;server.headersTimeout=3000
 server.closeCapabilities=async()=>{await tasks?.close();await qq?.idle()}
 server.once('close',()=>{server.closeCapabilities().catch(()=>{})})
 server.once('close',clearCustody)
 server.listen(port,'127.0.0.1',()=>console.log('lease authority ready (loopback)'))
 return server
}
