import {denyCognitiveSideEffect} from './activity-gate.mjs'
// Existing lease/outbox, actual OneBot event identifiers and original Hub rendering.
// No socket, QQ login or independently writable message channel is provided here.
import {hash,enqueueInTransaction} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {verifyRecoveryBoundary} from './admission-recovery.mjs'
import {dirname} from 'node:path'
import {createMediaBlobs} from './media-blobs.mjs'
import {AsyncLocalStorage} from 'node:async_hooks'
function identifier(value){const text=String(value??'');if(!/^-?\d+$/.test(text)||BigInt(text)===0n||(typeof value==='number'&&!Number.isSafeInteger(value)))throw new Error('stable OneBot identifier required');return text}
export function stablePokeMessageId(selfId,event){selfId=identifier(selfId);if(event?.post_type!=='notice'||event.notice_type!=='notify'||event.sub_type!=='poke'||identifier(event.self_id)!==selfId||identifier(event.target_id)!==selfId||!Number.isSafeInteger(event.time)||event.time<=0)throw Error('stable OneBot poke notice required');return '-'+BigInt('0x'+hash([selfId,'poke-notice',event.time,event.group_id||'',event.sender_id??event.user_id,event.target_id,event.action||'',event.suffix||'']).slice(0,12)).toString()}
export function validateReplyItems(items){if(!Array.isArray(items)||items.some(i=>!['text','voice','image','sticker','poke'].includes(i.kind)))throw Error('unsupported reply kind')}
export function createQQOutbound({lease,gateway,holder='local',term,selfId,allowTargets,transport,historyReader,toolContext,mediaReadRoots}){
 selfId=identifier(selfId)
 if(BigInt(selfId)<=0n)throw new Error('positive bot identifier required')
 if(!Array.isArray(allowTargets)||!allowTargets.length||typeof transport!=='function')throw new Error('trusted target/transport configuration required')
 process.env.TIDEMIND_REQUIRE_QQ_BINDING='1'
 const db=lease.openAuthority()
 const authorityFile=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main').file
 const media=createMediaBlobs({root:dirname(authorityFile),...(mediaReadRoots?{readRoots:mediaReadRoots}:{})})
 try{db.exec(`
 CREATE TABLE IF NOT EXISTS tide_input_payloads(id TEXT PRIMARY KEY,content_json TEXT,expires_at INTEGER NOT NULL,baseline_count INTEGER,baseline_hash TEXT);
 CREATE TABLE IF NOT EXISTS tide_input_recovery(id TEXT PRIMARY KEY,term INTEGER NOT NULL,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tide_input_journal(origin TEXT PRIMARY KEY,event_json TEXT,expires_at INTEGER NOT NULL,admission_id TEXT);
 CREATE TABLE IF NOT EXISTS tide_admissions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,chat_id TEXT NOT NULL,origins TEXT NOT NULL,content_hash TEXT NOT NULL,state TEXT NOT NULL,term INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS tide_inbox(origin TEXT PRIMARY KEY,body_hash TEXT NOT NULL,chat_id TEXT NOT NULL,reply_key TEXT);
 CREATE TABLE IF NOT EXISTS tide_qq_turns(turn_key TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn INTEGER NOT NULL,chat_id TEXT NOT NULL,origins TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS tide_qq_receipts(event_key TEXT NOT NULL,part INTEGER NOT NULL,state TEXT NOT NULL,message_id TEXT,PRIMARY KEY(event_key,part));
 CREATE TABLE IF NOT EXISTS tide_qq_actions(operation TEXT PRIMARY KEY,request_hash TEXT NOT NULL,source_turn TEXT NOT NULL,target_chat TEXT NOT NULL,event_key TEXT NOT NULL);
 `)
 if(!db.prepare('PRAGMA table_info(tide_qq_actions)').all().some(r=>r.name==='render_hash'))db.exec('ALTER TABLE tide_qq_actions ADD COLUMN render_hash TEXT')
 if(!db.prepare('PRAGMA table_info(tide_input_payloads)').all().some(r=>r.name==='source_origin'))db.exec("ALTER TABLE tide_input_payloads ADD COLUMN source_origin TEXT NOT NULL DEFAULT 'qq-user'")
 }finally{db.close()}
 const activeTerm=()=>typeof term==='function'?term():term
 const tx=fn=>lease.fenced(holder,activeTerm(),db=>{if(db.prepare('SELECT home FROM tide_head').get().home!==holder)throw new Error('standby is read-only');return fn(db)})
 const target=chatId=>{if(!allowTargets.includes(chatId)||!/^(private|group):\d+$/.test(chatId))throw new Error('target not authorized');const id=Number(chatId.split(':')[1]);if(!Number.isSafeInteger(id)||id<=0)throw new Error('safe target identifier required');return chatId}
 const turnKey=(sessionId,turn)=>{if(typeof sessionId!=='string'||!sessionId||!Number.isSafeInteger(turn)||turn<0)throw new Error('durable turn identity required');return hash([selfId,sessionId,turn])}
 function observeInbound(event,msg){
  denyCognitiveSideEffect()
  if(event.post_type!=='message'||!['private','group'].includes(event.message_type)||identifier(event.self_id)!==selfId)throw new Error('untrusted inbound event')
  const user=identifier(event.user_id),kind=event.message_type,id=identifier(event.message_id)
  const chatId=target(kind+':'+(kind==='group'?identifier(event.group_id):user))
  if(msg.chatId!==chatId||msg.messageId!==id||msg.userId!==user)throw new Error('inbound mapping mismatch')
  const origin=hash([selfId,kind,chatId,id]),bodyHash=hash([selfId,kind,chatId,user,event.message])
  return tx(db=>{
   const old=db.prepare('SELECT * FROM tide_inbox WHERE origin=?').get(origin)
   if(old){if(old.body_hash!==bodyHash)throw new Error('inbound event conflict');return {admitted:false,origin,duplicate:true}}
   const encoded=JSON.stringify({post_type:event.post_type,message_type:kind,self_id:selfId,user_id:user,message_id:id,group_id:kind==='group'?identifier(event.group_id):undefined,message:event.message})
   if(Buffer.byteLength(encoded)>65536)throw new Error('inbound journal payload too large')
   db.prepare('INSERT INTO tide_inbox VALUES(?,?,?,NULL)').run(origin,bodyHash,chatId)
   db.prepare('INSERT INTO tide_input_journal VALUES(?,?,?,NULL)').run(origin,encoded,Date.now()+86400000)
   return {admitted:true,origin,duplicate:false}
  })
 }
 function bindTurn({sessionId,turn,chatId,origins}){
  denyCognitiveSideEffect()
  target(chatId);const key=turnKey(sessionId,turn),ids=[...new Set(origins||[])].sort()
  if(!ids.length||ids.length>40)throw new Error('durable inbound origins required')
  return tx(db=>{
   for(const origin of ids){const r=db.prepare('SELECT chat_id FROM tide_inbox WHERE origin=?').get(origin);if(!r||r.chat_id!==chatId)throw new Error('turn origin/target mismatch')}
   const old=db.prepare('SELECT * FROM tide_qq_turns WHERE turn_key=?').get(key),encoded=JSON.stringify(ids)
   if(old){if(old.chat_id!==chatId||old.origins!==encoded)throw new Error('turn binding conflict');return key}
   db.prepare('INSERT INTO tide_qq_turns VALUES(?,?,?,?,?)').run(key,sessionId,turn,chatId,encoded);return key
  })
 }
 function pokeMessageId(event){
  return stablePokeMessageId(selfId,event)
 }
 function observePoke(event,msg){
  denyCognitiveSideEffect();const id=pokeMessageId(event),user=identifier(event.group_id?event.user_id:event.sender_id??event.user_id),chatId=target(event.group_id?'group:'+identifier(event.group_id):'private:'+user)
  if(msg.chatId!==chatId||msg.messageId!==id||msg.userId!==user)throw Error('poke notice mapping mismatch')
  const origin=hash([selfId,'poke-notice',chatId,id]),bodyHash=hash([chatId,id,user])
  return tx(db=>{const old=db.prepare('SELECT * FROM tide_inbox WHERE origin=?').get(origin);if(old){if(old.body_hash!==bodyHash)throw Error('poke notice conflict');return {admitted:false,origin,duplicate:true}}
   db.prepare('INSERT INTO tide_inbox VALUES(?,?,?,NULL)').run(origin,bodyHash,chatId)
   db.prepare('INSERT INTO tide_input_journal VALUES(?,?,?,NULL)').run(origin,JSON.stringify({kind:'poke-notice',time:event.time,chatId,user,id}),Date.now()+86400000)
   return {admitted:true,origin,duplicate:false}
  })
 }
 function observeAutonomous({id,moduleId,chatId,content}){
  denyCognitiveSideEffect();target(chatId)
  if(!['local','cloud'].includes(holder)||typeof id!=='string'||!id.startsWith('module:')||id.length>220||typeof moduleId!=='string'||!/^[a-z][a-z0-9-]{1,39}$/.test(moduleId))throw Error('trusted module activity identity required')
  const origin=hash([selfId,'module-event',id,chatId]),bodyHash=hash(content)
  return tx(db=>{const old=db.prepare('SELECT * FROM tide_inbox WHERE origin=?').get(origin)
   if(old){if(old.body_hash!==bodyHash||old.chat_id!==chatId)throw Error('module event conflict');return {origin,admitted:false}}
   db.prepare('INSERT INTO tide_inbox VALUES(?,?,?,NULL)').run(origin,bodyHash,chatId)
   db.prepare('INSERT INTO tide_input_journal VALUES(?,?,?,NULL)').run(origin,JSON.stringify({kind:'module-event',id,moduleId,chatId}),Date.now()+86400000)
   return {origin,admitted:true}
  })
 }
 // A flush returning successfully is NOT proof that complete durable history contains the input.
 // Interrupted/flush-unverified admissions stop here until the real session-log reader is wired.
 async function admitInput({sessionId,chatId,origins,content,followup,flush,sourceOrigin='qq-user'}){
  denyCognitiveSideEffect()
  target(chatId)
  if(!['qq-user','module-event'].includes(sourceOrigin))throw Error('known input source required')
  if(typeof sessionId!=='string'||!sessionId||typeof followup!=='function'||typeof flush!=='function')throw new Error('session admission/flush adapter required')
  const ids=[...new Set(origins||[])].sort()
  if(!ids.length||ids.length>40)throw new Error('durable inbound origins required')
  const id='tide-input-'+hash([selfId,sessionId,chatId,ids]),contentHash=hash(content)
  const existing=tx(db=>db.prepare('SELECT * FROM tide_admissions WHERE id=?').get(id))
  if(existing){
   if(existing.content_hash!==contentHash)throw new Error('admission content conflict')
   if(typeof historyReader!=='function')throw new Error('admission already attempted; durable history review required')
   const proof=await historyReader({sessionId,id,contentHash,sourceOrigin})
   if(proof.state!=='present')throw new Error('durable history did not confirm input; automatic replay denied')
   tx(db=>db.prepare("UPDATE tide_admissions SET state='accepted' WHERE id=?").run(id))
   return {id,state:'accepted',replayed:true,stage:proof.stage}
  }
  const baseline=typeof historyReader==='function'?await historyReader({sessionId,id,contentHash,sourceOrigin}):null
  if(baseline && baseline.state!=='absent')throw new Error('new admission requires confirmed absence in durable history')
  const encodedContent=JSON.stringify(content)
  if(Buffer.byteLength(encodedContent)>65536)throw new Error('admitted input too large')
  tx(db=>{
   const old=db.prepare('SELECT * FROM tide_admissions WHERE id=?').get(id)
   if(old){if(old.content_hash!==contentHash)throw new Error('admission content conflict');throw new Error('admission already attempted; durable history review required')}
   for(const origin of ids){const row=db.prepare('SELECT * FROM tide_input_journal WHERE origin=?').get(origin)
    const inbox=db.prepare('SELECT chat_id FROM tide_inbox WHERE origin=?').get(origin)
    if(!row||inbox?.chat_id!==chatId||row.expires_at<=Date.now()||row.admission_id)throw new Error('input unavailable, expired or already assigned')
    const moduleEvent=JSON.parse(row.event_json||'null')?.kind==='module-event'
    if(moduleEvent!==(sourceOrigin==='module-event'))throw Error('input source mismatch')
   }
   db.prepare('INSERT INTO tide_admissions VALUES(?,?,?,?,?,?,?)').run(id,sessionId,chatId,JSON.stringify(ids),contentHash,'dispatching',activeTerm())
   const expires=Math.min(...ids.map(origin=>db.prepare('SELECT expires_at FROM tide_input_journal WHERE origin=?').get(origin).expires_at))
   db.prepare('INSERT INTO tide_input_payloads(id,content_json,expires_at,baseline_count,baseline_hash,source_origin) VALUES(?,?,?,?,?,?)').run(id,encodedContent,expires,baseline?.state==='absent'?(baseline.eventCount??null):null,baseline?.state==='absent'?(baseline.historyHash??null):null,sourceOrigin)
   for(const origin of ids)db.prepare('UPDATE tide_input_journal SET admission_id=? WHERE origin=?').run(id,origin)
  })
  try{
   await followup({id,role:'user',content,source:{kind:'aurabot',origin:sourceOrigin}})
   await flush()
   tx(db=>db.prepare("UPDATE tide_admissions SET state='flushed_unverified' WHERE id=? AND state='dispatching'").run(id))
   if(typeof historyReader==='function'){
    const proof=await historyReader({sessionId,id,contentHash,sourceOrigin})
    if(proof.state!=='present')throw new Error('durable history did not confirm flushed input')
    tx(db=>db.prepare("UPDATE tide_admissions SET state='accepted' WHERE id=?").run(id))
    return {id,state:'accepted',stage:proof.stage}
   }
   return {id,state:'flushed_unverified'}
  }catch(error){
   // Preserve dispatching even if authority is unavailable; never turn it back into queued.
   throw new Error('admission interrupted; durable history review required',{cause:error})
  }
 }
 // No automatic replay route. The trusted host must supply an opaque clean-stop proof.
 async function recoverAdmission({id,ctx,agent,proof,dryRun=true}){
  denyCognitiveSideEffect()
  if(typeof historyReader!=='function')throw new Error('durable history reader required')
  const row=tx(db=>db.prepare('SELECT a.*,p.content_json,p.expires_at,p.baseline_count,p.baseline_hash,p.source_origin FROM tide_admissions a LEFT JOIN tide_input_payloads p ON p.id=a.id WHERE a.id=?').get(id))
  if(!row||row.session_id!==agent?.id)throw new Error('original admission not found for session')
  if(row.source_origin==='module-event')throw Error('interrupted module event requires review; no automatic recovery')
  target(row.chat_id)
  const seen=await historyReader({sessionId:row.session_id,id,contentHash:row.content_hash})
  if(seen.state==='present'){
   if(!dryRun)tx(db=>{db.prepare("UPDATE tide_admissions SET state='accepted' WHERE id=?").run(id);db.prepare("UPDATE tide_input_recovery SET state='accepted' WHERE id=?").run(id)})
   return {id,state:'accepted',replayed:true,submitted:false,dryRun}
  }
  if(seen.state!=='absent'||row.state==='accepted'||row.term>=activeTerm())throw new Error('absence, unconfirmed input and newer term required')
  const boundary=verifyRecoveryBoundary(proof,{ctx,agent,baselineCount:row.baseline_count,baselineHash:row.baseline_hash})
  const reserved=reserveAdmissionRecovery({id,sessionId:agent.id,seen,boundary,dryRun})
  const content=reserved.message.content
  if(dryRun)return {id,state:'ready',submitted:false,dryRun:true}
  // Persist claim before the side effect; any uncertain second failure stops further attempts.
  tx(()=>{
   verifyRecoveryBoundary(proof,{ctx,agent,baselineCount:row.baseline_count,baselineHash:row.baseline_hash})
   const result=agent.followup({id,role:'user',content,source:{kind:'aurabot',origin:'qq-user'}})
   if(result!==undefined)throw new Error('synchronous native followup required')
  })
  await ctx.sessions.flush(agent.session)
  const confirmed=await historyReader({sessionId:row.session_id,id,contentHash:row.content_hash})
  if(confirmed.state!=='present')throw new Error('recovery outcome unknown; review required')
  tx(db=>{db.prepare("UPDATE tide_admissions SET state='accepted' WHERE id=?").run(id);db.prepare("UPDATE tide_input_recovery SET state='accepted' WHERE id=?").run(id)})
  return {id,state:'accepted',submitted:true,dryRun:false}
 }
 function admissionEvidence(id){return tx(db=>{const row=db.prepare('SELECT a.*,p.baseline_count,p.baseline_hash,p.source_origin FROM tide_admissions a LEFT JOIN tide_input_payloads p ON p.id=a.id WHERE a.id=?').get(id);if(!row)throw Error('original admission missing');return {id,sessionId:row.session_id,chatId:row.chat_id,origins:JSON.parse(row.origins),contentHash:row.content_hash,sourceOrigin:row.source_origin||'qq-user',baselineCount:row.baseline_count,baselineHash:row.baseline_hash}})}
 function reserveAdmissionRecovery({id,sessionId,seen,boundary,dryRun=true}){
  const row=tx(db=>db.prepare('SELECT a.*,p.content_json,p.expires_at,p.baseline_count,p.baseline_hash,p.source_origin FROM tide_admissions a LEFT JOIN tide_input_payloads p ON p.id=a.id WHERE a.id=?').get(id))
  if(!row||row.session_id!==sessionId||row.source_origin==='module-event')throw Error('original recoverable owner input required')
  target(row.chat_id)
  if(seen.state==='present'){if(!dryRun)tx(db=>{db.prepare("UPDATE tide_admissions SET state='accepted' WHERE id=?").run(id);db.prepare("UPDATE tide_input_recovery SET state='accepted' WHERE id=?").run(id)});return {id,state:'accepted',replayed:true,submitted:false,dryRun}}
  if(seen.state!=='absent'||row.state==='accepted'||row.term>=activeTerm())throw new Error('absence, unconfirmed input and newer term required')
  if(!row.content_json||row.expires_at<=Date.now()||row.baseline_hash===null)throw new Error('original input expired, missing or unanchored')
  const content=JSON.parse(row.content_json)
  if(hash(content)!==row.content_hash)throw new Error('stored input content conflict')
  if(boundary.historyHash!==seen.historyHash||boundary.eventCount!==seen.eventCount||seen.pendingCount!==0)throw new Error('history does not match stopped checkpoint')
  function available(db){
   if(db.prepare('SELECT id FROM tide_input_recovery WHERE id=?').get(id))throw new Error('recovery already attempted; review required')
   const current=db.prepare('SELECT state,term FROM tide_admissions WHERE id=?').get(id)
   if(current.state!==row.state||current.term!==row.term)throw new Error('admission changed during recovery')
   const origins=JSON.parse(row.origins)
   for(const origin of origins){const r=db.prepare('SELECT reply_key FROM tide_inbox WHERE origin=?').get(origin);if(!r||r.reply_key)throw new Error('input already bound to reply')}
   if(db.prepare('SELECT origins FROM tide_qq_turns').all().some(r=>JSON.parse(r.origins).some(o=>origins.includes(o))))throw new Error('input already bound to turn')
  }
  tx(db=>{available(db);if(!dryRun)db.prepare("INSERT INTO tide_input_recovery VALUES(?,?,'claimed')").run(id,activeTerm())})
  return {id,state:'ready',submitted:false,dryRun,message:{id,role:'user',content,source:{kind:'aurabot',origin:'qq-user'}}}
 }
 async function reviewAdmissions({ids}={}){
  if(ids!==undefined&&(!Array.isArray(ids)||ids.length>64||ids.some(id=>typeof id!=='string')))throw Error('bounded admission IDs required')
  if(typeof historyReader!=='function')throw new Error('trusted durable history reader required')
  const rows=tx(db=>db.prepare('SELECT a.id,a.session_id,a.content_hash,a.state,p.source_origin FROM tide_admissions a LEFT JOIN tide_input_payloads p ON p.id=a.id ORDER BY a.id').all()),results=[]
  for(const row of rows){
   if(ids&&!ids.includes(row.id))continue
   const proof=await historyReader({sessionId:row.session_id,id:row.id,contentHash:row.content_hash,sourceOrigin:row.source_origin||'qq-user'})
   if(proof.state==='present')tx(db=>{db.prepare("UPDATE tide_admissions SET state='accepted' WHERE id=? AND content_hash=?").run(row.id,row.content_hash);db.prepare("UPDATE tide_input_recovery SET state='accepted' WHERE id=?").run(row.id)})
   results.push({id:row.id,state:proof.state==='present'?'accepted':'needs_review',evidence:proof.state,stage:proof.stage||'unknown',automaticReplay:false})
  }
  return results
 }
 function recoveryBinding(id){return tx(db=>{const r=db.prepare('SELECT session_id,chat_id,origins FROM tide_admissions WHERE id=?').get(id);if(!r)throw new Error('admission not found');target(r.chat_id);return {sessionId:r.session_id,chatId:r.chat_id,origins:JSON.parse(r.origins)}})}
 function recoveryStatus(){return tx(db=>({
  queued:db.prepare("SELECT origin,expires_at FROM tide_input_journal WHERE admission_id IS NULL ORDER BY origin").all().map(r=>({...r,state:r.expires_at>Date.now()?'queued':'expired'})),
  admissions:db.prepare('SELECT id,session_id,chat_id,state,term FROM tide_admissions ORDER BY id').all(),
  recoveries:db.prepare('SELECT id,term,state FROM tide_input_recovery ORDER BY id').all(),
  automaticReplay:false
 }))}
 function purgeExpiredInputs(){return tx(db=>{const removed=db.prepare('UPDATE tide_input_journal SET event_json=NULL WHERE expires_at<=? AND event_json IS NOT NULL').run(Date.now()).changes;const payloads=db.prepare('UPDATE tide_input_payloads SET content_json=NULL WHERE expires_at<=? AND content_json IS NOT NULL').run(Date.now()).changes;return {removed,payloads}})}
 const pending=new Set()
 const sendIntent=new AsyncLocalStorage()
 const deliveryUnknown=()=>{const error=Error('QQ delivery unconfirmed; automatic resend denied');error.code='TIDEMIND_DELIVERY_UNKNOWN';return error}
 async function dispatchQueued(queued,items=[],guard=()=>{}){
  guard()
  const requests=tx(db=>{const row=db.prepare('SELECT payload FROM tide_outbox WHERE event_key=?').get(queued.key);if(!row)throw Error('queued payload missing');const payload=JSON.parse(row.payload);if(!['aurabot-reply-v1','aurabot-reply-v2','aurabot-tool-v1'].includes(payload.format)||!Array.isArray(payload.requests)||payload.requests.length>8)throw Error('invalid outgoing manifest');if(!items.length&&Array.isArray(payload.items))items=payload.items;return payload.requests})
  const outcome=await gateway.dispatch(lease,holder,activeTerm(),queued.key,async()=>{
   const receipts=[]
   for(let i=0;i<requests.length;i++){
    denyCognitiveSideEffect()
    tx(db=>{
     const row=db.prepare('SELECT state FROM tide_qq_receipts WHERE event_key=? AND part=?').get(queued.key,i)
     if(row?.state!=='pending')throw new Error('part already attempted')
     db.prepare("UPDATE tide_qq_receipts SET state='unknown' WHERE event_key=? AND part=?").run(queued.key,i)
    })
    guard();const packet=requests[i];const destination=packet.action==='send_private_msg'?'private:'+packet.params.user_id:packet.action==='send_group_msg'?'group:'+packet.params.group_id:packet.action==='send_poke'?(packet.params.group_id?'group:'+packet.params.group_id:'private:'+packet.params.user_id):null;target(destination);const params=packet.action==='send_poke'?{...packet.params}:{...packet.params,message:media.materializeMessage(packet.params.message)};const response=await transport(packet.action,params)
    if(response?.status==='failed'||(response?.retcode!==undefined&&response.retcode!==0))throw new Error('OneBot rejected send')
    const messageId=packet.action==='send_poke'?'ack:'+hash([queued.key,i]):identifier(response?.message_id)
    const db=lease.openAuthority()
    try{db.prepare("UPDATE tide_qq_receipts SET state='sent',message_id=? WHERE event_key=? AND part=? AND state='unknown'").run(messageId,queued.key,i)}finally{db.close()}
    receipts.push(messageId)
   }
   return {id:JSON.stringify(receipts)}
  })
  return {...outcome,messageCount:requests.length,items}
 }
 async function replyImpl({sessionId,turn,chatId,replyIdentity,renderHash},render){
  denyCognitiveSideEffect()
  target(chatId);const key=turnKey(sessionId,turn)
  // Check actor BEFORE rendering hooks or invoking any optional subsystem.
  const binding=tx(db=>{const r=db.prepare('SELECT * FROM tide_qq_turns WHERE turn_key=?').get(key);if(!r||r.chat_id!==chatId)throw new Error('turn not bound');return {...r}})
  if(renderHash!==undefined&&!/^[a-f0-9]{64}$/.test(renderHash))throw Error('valid rendered reply hash required')
  const identity=typeof replyIdentity==='string'?hash(['final',replyIdentity]):null,operation='final:'+key
  if(identity){const old=tx(db=>db.prepare('SELECT * FROM tide_qq_actions WHERE operation=?').get(operation));if(old){if(old.request_hash!==identity||old.target_chat!==chatId||renderHash!==undefined&&old.render_hash!==renderHash)throw Error('reply identity conflict');return dispatchQueued({key:old.event_key})}}
  const captured=await render()
  if(!captured||!Array.isArray(captured.sent)||(!Array.isArray(captured.result)&&captured.sent.length))throw new Error('original Hub capture required')
  if(renderHash!==undefined&&renderHash!==hash(captured))throw Error('rendered reply hash differs')
  validateItems(captured.result||[])
  if(captured.sent.length>8)throw new Error('reply parts exceed reviewed limit')
  const requests=captured.sent.map(item=>{
   if(item.chatId!==chatId)throw new Error('captured target/segment not allowed')
   const [kind,id]=chatId.split(':')
   if(item.pokeUserId!==undefined)return pokeRequest(chatId,item.pokeUserId)
   return {action:kind==='group'?'send_group_msg':'send_private_msg',params:{[kind==='group'?'group_id':'user_id']:Number(id),message:media.freezeMessage(item.message)}}
  })
  if(requests.flatMap(r=>r.params.message||[]).reduce((total,s)=>total+(s.data.file?.bytes||0),0)>32*1024*1024)throw Error('reply media total exceeds limit')
  const payload=JSON.stringify({format:'aurabot-reply-v2',requests,items:(captured.result||[]).map(item=>['text','voice'].includes(item.kind)?item:{...item,value:'[immutable media]'})}),origins=JSON.parse(binding.origins)
  const queued=tx(db=>{
   if(identity){const old=db.prepare('SELECT * FROM tide_qq_actions WHERE operation=?').get(operation);if(old){if(old.request_hash!==identity||old.target_chat!==chatId||renderHash!==undefined&&old.render_hash!==renderHash)throw Error('reply identity conflict');return {key:old.event_key}}}
   if(requests.some(r=>(r.params.message||[]).some(s=>['image','record'].includes(s.type)))&&db.prepare("SELECT 1 FROM tide_qq_actions a JOIN tide_outbox o ON o.event_key=a.event_key WHERE a.source_turn=? AND o.state='unknown' LIMIT 1").get(key))throw deliveryUnknown()
   const out=enqueueInTransaction(db,holder,activeTerm(),{channel:'qq:'+selfId+':'+chatId,eventId:hash(origins),payload})
   for(const origin of origins){
    const old=db.prepare('SELECT reply_key FROM tide_inbox WHERE origin=?').get(origin)
    if(old.reply_key&&old.reply_key!==out.key)throw new Error('overlapping merged reply would duplicate an inbound event')
    db.prepare('UPDATE tide_inbox SET reply_key=? WHERE origin=?').run(out.key,origin)
   }
   for(let i=0;i<requests.length;i++)db.prepare("INSERT OR IGNORE INTO tide_qq_receipts VALUES(?,?,'pending',NULL)").run(out.key,i)
   if(identity)db.prepare('INSERT INTO tide_qq_actions(operation,request_hash,source_turn,target_chat,event_key,render_hash) VALUES(?,?,?,?,?,?)').run(operation,identity,key,chatId,out.key,hash(captured))
   return out
  })
  return dispatchQueued(queued,captured.result||[])
 }
 const validateItems=validateReplyItems
 const inboundScope=new AsyncLocalStorage()
 function currentSendFrame(){const scope=inboundScope.getStore();if(!scope)return toolContext?.();return {...scope,sequence:scope.sequence++,guard:()=>{if(!scope.active)throw Error('inbound send scope ended');tx(()=>{})}}}
 async function withInboundEvent({origin,chatId,label},fn){
  denyCognitiveSideEffect();target(chatId)
  if(!['local','cloud'].includes(holder)||!['command','message-hook'].includes(label)||typeof fn!=='function')throw Error('host inbound operation required')
  tx(db=>{const row=db.prepare('SELECT chat_id FROM tide_inbox WHERE origin=?').get(origin);if(!row||row.chat_id!==chatId)throw Error('durable inbound event required')})
  const sessionId='host-event:'+origin,turn=0
  bindTurn({sessionId,turn,chatId,origins:[origin]})
  const scope={sessionId,turn,callId:label,sequence:0,active:true}
  try{return await inboundScope.run(scope,fn)}finally{scope.active=false}
 }
 function pokeRequest(chatId,userId){
  target(chatId);const id=Number(userId)
  if(!Number.isSafeInteger(id)||id<=0||chatId.startsWith('private:')&&String(id)!==chatId.slice(8))throw Error('invalid poke target')
  return {action:'send_poke',params:{user_id:id,...(chatId.startsWith('group:')?{group_id:Number(chatId.slice(6))}:{})}}
 }
 async function sendImpl({chatId,message,pokeUserId}){
  denyCognitiveSideEffect();target(chatId)
  const intent=sendIntent.getStore(),frame=intent?.frame||currentSendFrame();if(!frame||!['local','cloud'].includes(holder))throw Error('unbound direct send denied')
  if(intent&&!intent.active)throw Error('send intent ended')
  frame.guard();const sourceKey=turnKey(frame.sessionId,frame.turn)
  const binding=tx(db=>db.prepare('SELECT * FROM tide_qq_turns WHERE turn_key=?').get(sourceKey))
  if(!binding)throw Error('actual tool turn not bound to durable input')
  const frozen=pokeUserId!==undefined?{poke:pokeRequest(chatId,pokeUserId)}:media.freezeMessage(message),origins=JSON.parse(binding.origins)
  const fingerprint=intent?.fingerprint||hash(['tool-send',selfId,origins,chatId,frozen]),operation='tool:'+hash([selfId,frame.sessionId,frame.turn,frame.callId,frame.sequence])
  const [kind,id]=chatId.split(':'),requests=pokeUserId!==undefined?[frozen.poke]:[{action:kind==='group'?'send_group_msg':'send_private_msg',params:{[kind==='group'?'group_id':'user_id']:Number(id),message:frozen}}]
  frame.guard()
  const queued=tx(db=>{
   const old=db.prepare('SELECT * FROM tide_qq_actions WHERE operation=?').get(operation)
   if(old){if(old.request_hash!==fingerprint||old.target_chat!==chatId)throw Error('tool send operation conflict');return {key:old.event_key}}
   if(db.prepare("SELECT 1 FROM tide_qq_actions a JOIN tide_outbox o ON o.event_key=a.event_key WHERE a.source_turn=? AND o.state='unknown' LIMIT 1").get(sourceKey))throw deliveryUnknown()
   const equivalent=db.prepare('SELECT event_key FROM tide_qq_actions WHERE request_hash=?').get(fingerprint)
   const out=equivalent?{key:equivalent.event_key}:enqueueInTransaction(db,holder,activeTerm(),{channel:'qq:'+selfId+':'+chatId,eventId:operation,payload:JSON.stringify({format:'aurabot-tool-v1',requests})})
   db.prepare('INSERT INTO tide_qq_actions(operation,request_hash,source_turn,target_chat,event_key) VALUES(?,?,?,?,?)').run(operation,fingerprint,sourceKey,chatId,out.key)
   db.prepare("INSERT OR IGNORE INTO tide_qq_receipts VALUES(?,0,'pending',NULL)").run(out.key)
   return out
  })
  const result=await dispatchQueued(queued,[],frame.guard)
  if(result.state!=='sent')throw deliveryUnknown()
  const receipt=tx(db=>db.prepare('SELECT receipt FROM tide_outbox WHERE event_key=?').get(queued.key).receipt)
  const ids=JSON.parse(receipt);return {message_id:pokeUserId!==undefined?undefined:ids[0],acknowledged:pokeUserId!==undefined,replayed:!result.attempted}
 }
 async function withSendIntent({chatId,identity},fn,onReplay=value=>value){
  denyCognitiveSideEffect();target(chatId)
  const frame=currentSendFrame();if(!frame||!['local','cloud'].includes(holder))throw Error('unbound direct send denied')
  const sourceKey=turnKey(frame.sessionId,frame.turn),operation='tool:'+hash([selfId,frame.sessionId,frame.turn,frame.callId,frame.sequence])
  const fingerprint=tx(db=>{const binding=db.prepare('SELECT origins FROM tide_qq_turns WHERE turn_key=?').get(sourceKey);if(!binding)throw Error('actual tool turn not bound to durable input');return hash(['tool-intent',selfId,JSON.parse(binding.origins),chatId,identity])})
  const old=tx(db=>{
   const row=db.prepare('SELECT * FROM tide_qq_actions WHERE operation=?').get(operation)
   if(row){if(row.request_hash!==fingerprint||row.target_chat!==chatId)throw Error('tool send operation conflict');return row}
   if(db.prepare("SELECT 1 FROM tide_qq_actions a JOIN tide_outbox o ON o.event_key=a.event_key WHERE a.source_turn=? AND o.state='unknown' LIMIT 1").get(sourceKey))throw deliveryUnknown()
   return db.prepare('SELECT * FROM tide_qq_actions WHERE request_hash=?').get(fingerprint)
  })
  if(old){
   const result=await dispatchQueued({key:old.event_key},[],frame.guard);if(result.state!=='sent')throw deliveryUnknown()
   const saved=tx(db=>{const row=db.prepare('SELECT payload,receipt FROM tide_outbox WHERE event_key=?').get(old.event_key);return {messageType:JSON.parse(row.payload).requests[0]?.params.message?.[0]?.type,message_id:JSON.parse(row.receipt)[0]}})
   return onReplay({replayed:true,...saved})
  }
  const scope={frame,fingerprint,active:true}
  try{return await sendIntent.run(scope,fn)}finally{scope.active=false}
 }
 // It is unsafe to rely on hooks.send: the original Hub catches hook errors.
 // The original client visible to Hub has NO privileged write fallback.
 const guardedClient=Object.freeze({call:async()=>{throw new Error('direct OneBot capability denied')}})
 function reply(...args){const work=replyImpl(...args);pending.add(work);work.finally(()=>pending.delete(work)).catch(()=>{});return work}
 function send(...args){const work=sendImpl(...args);pending.add(work);work.finally(()=>pending.delete(work)).catch(()=>{});return work}
 return {observeInbound,observePoke,pokeMessageId,observeAutonomous,bindTurn,admitInput,recoverAdmission,admissionEvidence,reserveAdmissionRecovery,recoveryBinding,reviewAdmissions,recoveryStatus,purgeExpiredInputs,reply,validateItems,withInboundEvent,idle:async()=>{while(pending.size)await Promise.allSettled([...pending])},send,withSendIntent,guardedClient,
  audit(){const db=lease.openAuthority();try{return {inbox:db.prepare('SELECT count(*) n FROM tide_inbox').get().n,
   outbox:db.prepare('SELECT event_key,state,term FROM tide_outbox ORDER BY event_key').all(),
   parts:db.prepare('SELECT event_key,part,state,message_id FROM tide_qq_receipts ORDER BY event_key,part').all()}}finally{db.close()}}}
}
