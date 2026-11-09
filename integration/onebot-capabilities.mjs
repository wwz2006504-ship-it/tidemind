// Host-only capability boundary. Modules receive ONLY moduleClient; raw transport never escapes.
import {AsyncLocalStorage} from 'node:async_hooks'
import {randomUUID} from 'node:crypto'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {createQQOutbound} from './qq-outbound.mjs'
import {assertCognitiveActive,denyCognitiveSideEffect} from './activity-gate.mjs'
const context=new AsyncLocalStorage()
const reads={get_stranger_info:['user_id','no_cache'],get_msg:['message_id'],get_image:['file'],get_record:['file','out_format'],fetch_ptt_text:['message_id'],get_forward_msg:['id'],get_qzone_msg_list:['num'],get_qzone_msg_detail:['tid','target_uin','num'],get_qzone_feeds:['count'],set_input_status:['user_id','event_type'],get_login_info:[],get_group_info:['group_id','no_cache'],get_group_member_info:['group_id','user_id','no_cache'],get_friend_msg_history:['user_id','count'],get_group_msg_history:['group_id','count']}
const tools={set_group_ban:['group_id','user_id','duration'],set_group_kick:['group_id','user_id','reject_add_request'],set_group_special_title:['group_id','user_id','special_title'],_send_group_notice:['group_id','content']}
// Share the original classification with the async host adapter, not a second policy list.
export const classifyQQAction=action=>Object.hasOwn(reads,action)?'read':typeof action==='string'&&action.startsWith('send_')?'send':'tool'
const identifier=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<=0)throw Error('positive safe QQ identifier required');return n}
const snapshot=p=>{if(!p||typeof p!=='object'||Array.isArray(p))throw Error('plain request parameters required');const c=structuredClone(p);JSON.stringify(c);return c}
export function createOneBotCapabilities({lease,gateway,holder='local',term,selfId,allowTargets,transport,authorize,historyReader,authorizationMode='autonomous',assertHostActive=()=>{}}){
 if(!['autonomous','per-call'].includes(authorizationMode))throw Error('unknown tool authorization policy')
 selfId=identifier(selfId)
 if(typeof transport!=='function'||!Array.isArray(allowTargets)||!allowTargets.length)throw Error('trusted transport and explicit targets required')
 for(const t of allowTargets)if(!/^(private|group):[1-9]\d*$/.test(t))throw Error('explicit QQ target required')
 const currentTerm=()=>typeof term==='function'?term():term
 const fence=fn=>lease.fenced(holder,currentTerm(),db=>{if(gatewayHome(db)!==holder)throw Error('standby cannot use QQ');return fn(db)})
 function gatewayHome(db){return db.prepare('SELECT home FROM tide_head').get().home}
 fence(db=>db.exec(`CREATE TABLE IF NOT EXISTS tide_tool_permits(op TEXT PRIMARY KEY,request_hash TEXT NOT NULL,approval_id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,call_id TEXT NOT NULL,action TEXT NOT NULL,params_hash TEXT NOT NULL,holder TEXT NOT NULL,term INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,attempt_id TEXT,result_hash TEXT);`))
 const tickets=new WeakMap()
 function normalize(action,params){
  const allowed=Object.hasOwn(reads,action)?reads[action]:Object.hasOwn(tools,action)?tools[action]:null
  if(!allowed){if(authorizationMode!=='autonomous'||typeof action!=='string'||!/^[_a-zA-Z][_a-zA-Z0-9]{0,63}$/.test(action)||/^send_(?:private_msg|group_msg|msg|forward_msg|group_forward_msg|private_forward_msg)$/.test(action))throw Error('QQ capability not reviewed; direct sends must use bound outbox');const p=snapshot(params);if(Buffer.byteLength(JSON.stringify(p))>65536)throw Error('request too large');return p}
  const p=snapshot(params)
  if(Object.keys(p).some(k=>!allowed.includes(k)))throw Error('unsupported QQ parameter')
  if(action!=='get_login_info'&&allowed.some(k=>['group_id','user_id'].includes(k))){
   if(allowed.includes('user_id')&&!allowed.includes('group_id')){p.user_id=identifier(p.user_id);if(!allowTargets.includes('private:'+p.user_id))throw Error('private target denied')}
   else{p.group_id=identifier(p.group_id);if(!allowTargets.includes('group:'+p.group_id))throw Error('group target denied');if(allowed.includes('user_id'))p.user_id=identifier(p.user_id)}
  }
  if(Buffer.byteLength(JSON.stringify(p))>65536)throw Error('request too large')
  if(action==='set_input_status'&&![0,1,2,3,4,5,6,7,8,9,10].includes(p.event_type))throw Error('invalid input status')
  if('count'in p){if(!Number.isSafeInteger(p.count)||p.count<1||p.count>50)throw Error('bounded history count required')}
  if(action.endsWith('_msg_history')&&!('count'in p))p.count=20
  for(const flag of ['no_cache','reject_add_request'])if(flag in p&&typeof p[flag]!=='boolean')throw Error('boolean option required')
  if(action==='set_group_ban'&&(!Number.isSafeInteger(p.duration)||p.duration<0||p.duration>2592000))throw Error('bounded ban duration required')
  if(action==='set_group_special_title'&&(typeof p.special_title!=='string'||p.special_title.length>128))throw Error('bounded title required')
  if(action==='_send_group_notice'&&(typeof p.content!=='string'||!p.content||p.content.length>1024))throw Error('bounded notice required')
  return p
 }
 function options(value={}){if(!value||Object.keys(value).some(k=>k!=='timeoutMs'))throw Error('unsupported transport option');const ms=value.timeoutMs??8000;if(!Number.isFinite(ms)||ms<1||ms>30000)throw Error('bounded transport timeout required');return {timeoutMs:ms,singleAttempt:true}}
 function mint(request,row){const ticket=Object.freeze({kind:'one-call-permit'});tickets.set(ticket,{request,expiresAt:row.expires_at});return {ticket,state:row.state,replayed:!!row.replayed}}
 async function grantTool({op,sessionId,callId,action,params,ttlMs=30000}){
  assertHostActive()
  denyCognitiveSideEffect()
  if(holder!=='local')throw Error('local tool authorization unavailable in cloud')
  for(const v of [op,sessionId,callId])if(typeof v!=='string'||!v||v.length>160)throw Error('operation, session and call identity required')
  if(Object.hasOwn(reads,action)||/^send_(?:private_msg|group_msg|msg|forward_msg|group_forward_msg|private_forward_msg)$/.test(action)||(authorizationMode==='per-call'&&!Object.hasOwn(tools,action)))throw Error('tool execution record cannot authorize chat sends')
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000)throw Error('short authorization lifetime required')
  const p=normalize(action,params),request=Object.freeze({op,sessionId,callId,action,params:Object.freeze(p),holder,term:currentTerm()}),requestHash=hash(request)
  const old=fence(db=>db.prepare('SELECT * FROM tide_tool_permits WHERE op=?').get(op))
  if(old){if(old.request_hash!==requestHash)throw Error('tool operation conflict');if(old.state==='approved'&&old.expires_at>Date.now())return mint(request,{...old,replayed:true});return {ticket:null,state:old.state==='approved'?'expired':old.state,replayed:true}}
  if(authorizationMode==='per-call'&&typeof authorize!=='function')throw Error('human per-call authorization provider required')
  const decision=authorizationMode==='autonomous'?{decision:'allow-once',approvalId:'autonomous:'+requestHash,requestHash}:await authorize(Object.freeze({...request,requestHash}))
  if(decision?.decision!=='allow-once'||decision.requestHash!==requestHash||typeof decision.approvalId!=='string'||!decision.approvalId||decision.approvalId.length>160)throw Error('per-call approval missing or mismatched')
  if(request.term!==currentTerm())throw Error('approval belongs to previous term')
  const row=fence(db=>{
   const concurrent=db.prepare('SELECT * FROM tide_tool_permits WHERE op=?').get(op)
   if(concurrent){if(concurrent.request_hash!==requestHash||concurrent.approval_id!==decision.approvalId)throw Error('concurrent approval conflict');return concurrent}
   const expires=Date.now()+ttlMs
   db.prepare("INSERT INTO tide_tool_permits VALUES(?,?,?,?,?,?,?,?,?,?,'approved',NULL,NULL)").run(op,requestHash,decision.approvalId,sessionId,callId,action,hash(p),holder,request.term,expires)
   return {state:'approved',expires_at:expires}
  })
  if(row.state!=='approved'||row.expires_at<=Date.now())return {ticket:null,state:row.state,replayed:true}
  return mint(request,row)
 }
 async function withToolPermit(ticket,{sessionId,callId},fn){
  denyCognitiveSideEffect();const issued=tickets.get(ticket)
  if(!issued||issued.request.sessionId!==sessionId||issued.request.callId!==callId||typeof fn!=='function')throw Error('host-owned call-bound permit required')
  const request=issued.request
  fence(db=>{const row=db.prepare('SELECT * FROM tide_tool_permits WHERE op=?').get(request.op)
   if(!row||row.state!=='approved'||row.expires_at<=Date.now()||row.term!==currentTerm()||row.holder!==holder||row.request_hash!==hash(request))throw Error('permit expired, used or fenced')
   db.prepare("UPDATE tide_tool_permits SET state='executing' WHERE op=?").run(request.op)
  })
  const scope={router:tickets,issued,active:true,guard:context.getStore()?.guard}
  try{return await context.run(scope,fn)}finally{
   scope.active=false
   // End the grant with its actual host invocation, even if the module never used it.
   let db;try{db=lease.openAuthority();db.prepare("UPDATE tide_tool_permits SET state='unused' WHERE op=? AND state='executing' AND request_hash=?").run(request.op,hash(request))}catch{}finally{db?.close()}
  }
 }
 function wrapTool(ticket,definition){
  if(!tickets.has(ticket)||typeof definition?.execute!=='function')throw Error('host-owned permit and tool definition required')
  return {...definition,execute:(args,exec)=>{
   const issued=tickets.get(ticket)
   if(exec?.agent?.id!==issued.request.sessionId||exec?.agent?.session?.id!==issued.request.sessionId)throw Error('actual tool agent/session mismatch')
   return withToolPermit(ticket,{sessionId:exec.agent.session.id,callId:exec.callId},()=>definition.execute(args,exec))
  }}
 }
 function wrapAutonomousTool(definition,{guard=()=>{}}={}){
  if(authorizationMode!=='autonomous'||typeof definition?.execute!=='function')throw Error('autonomous host tool required')
  return {...definition,execute:async(args,exec)=>{
   if(!exec?.agent?.session?.id||exec.agent.id!==exec.agent.session.id||typeof exec.callId!=='string'||!exec.callId)throw Error('actual host tool invocation required')
   guard()
   assertHostActive();assertCognitiveActive();fence(()=>{})
   const scope={router:tickets,exec,active:true,sequence:0,guard}
   try{return await context.run(scope,()=>definition.execute(args,exec))}finally{scope.active=false}
  }}
 }
 function record(op,attempt,state,value){const db=lease.openAuthority();try{db.prepare("UPDATE tide_tool_permits SET state=?,result_hash=? WHERE op=? AND attempt_id=? AND state='attempted'").run(state,hash(value),op,attempt)}finally{db.close()}}
 async function call(action,params={},opts={}){
  assertHostActive()
  const invocation=context.getStore()
  if(invocation?.router===tickets){if(!invocation.active)throw Error('host invocation ended');invocation.guard?.()}
  if(['send_private_msg','send_group_msg','send_poke'].includes(action)){
   if(authorizationMode!=='autonomous')throw Error('QQ capability not reviewed; direct sends must use bound outbox')
   options(opts);const p=snapshot(params),group=action==='send_group_msg'||action==='send_poke'&&p.group_id!==undefined
   const allowed=action==='send_poke'?['user_id','group_id']:group?['group_id','message']:['user_id','message']
   if(Object.keys(p).some(k=>!allowed.includes(k)))throw Error('unsupported outgoing parameter')
   const chatId=(group?'group:':'private:')+identifier(group?p.group_id:p.user_id)
   try{return await outbound.send(action==='send_poke'?{chatId,pokeUserId:identifier(p.user_id)}:{chatId,message:typeof p.message==='string'?[{type:'text',data:{text:p.message}}]:p.message})}
   catch(error){if(error.message==='unbound direct send denied')error.message+='; direct sends must use bound outbox';throw error}
  }
  if(action==='set_input_status'&&authorizationMode==='per-call')throw Error('QQ capability not reviewed')
  const p=normalize(action,params),safeOptions=options(opts)
  if(Object.hasOwn(reads,action)){
   assertCognitiveActive();fence(()=>{})
   let result;try{result=await transport(action,p,safeOptions)}catch{throw Error('QQ read unavailable')}
   fence(()=>{});assertCognitiveActive();assertHostActive();invocation?.guard?.();return result
  }
  denyCognitiveSideEffect()
  const scope=context.getStore()
  if(authorizationMode==='autonomous'&&scope?.router===tickets&&scope.active&&scope.exec){
   const exec=scope.exec,op='autonomous:'+hash([exec.agent.session.id,exec.callId,action,scope.sequence++])
   const grant=await grantTool({op,sessionId:exec.agent.session.id,callId:exec.callId,action,params:p})
   scope.guard?.()
   if(!grant.ticket){if(grant.state==='succeeded')return {replayed:true};throw Error('previous tool result requires review; automatic retry denied')}
   return wrapTool(grant.ticket,{execute:()=>call(action,p,opts)}).execute({},exec)
  }
  const permit=scope?.router===tickets&&scope.active?scope.issued:null
  if(!permit||permit.request.action!==action||hash(permit.request.params)!==hash(p))throw Error(authorizationMode==='autonomous'?'host tool invocation context required':'per-call authorization required for exact QQ operation')
  const request=permit.request,attempt=randomUUID()
  fence(db=>{const row=db.prepare('SELECT * FROM tide_tool_permits WHERE op=?').get(request.op)
   if(holder!=='local'||!row||row.state!=='executing'||row.expires_at<=Date.now()||row.term!==currentTerm()||row.holder!==holder||row.request_hash!==hash(request))throw Error('permit expired, used or fenced')
   db.prepare("UPDATE tide_tool_permits SET state='attempted',attempt_id=? WHERE op=?").run(attempt,request.op)
  })
  let result
  try{result=await transport(action,p,safeOptions);if(result?.status==='failed'||(Object.hasOwn(result??{},'retcode')&&result.retcode!==0))throw Error('rejected')}
  catch{record(request.op,attempt,'unknown',{outcome:'unconfirmed'});throw Error('tool outcome unconfirmed; automatic retry denied')}
  // An ACK can be recorded for this attempted operation after term loss; it grants no new action.
  record(request.op,attempt,'succeeded',{acknowledged:true});return result
 }
 const moduleClient=Object.freeze({call})
 const toolContext=()=>{
  const scope=context.getStore()
  if(authorizationMode!=='autonomous'||scope?.router!==tickets||!scope.exec||!scope.active)return null
  const guard=()=>{if(!scope.active)throw Error('host invocation ended');scope.exec.signal?.throwIfAborted();assertHostActive();assertCognitiveActive();scope.guard?.();fence(()=>{})}
  guard();const {agent,callId}=scope.exec
  const turn=agent.session.snapshotEvents?.().findLast(e=>e.type==='turn/start')?.data?.turn??agent.turn
  if(!Number.isSafeInteger(turn)||turn<1)throw Error('actual native tool turn required')
  return {sessionId:agent.session.id,callId,turn,sequence:scope.sequence++,guard}
 }
 const outbound=createQQOutbound({lease,gateway,holder,term,selfId,allowTargets,historyReader,toolContext,transport:async(action,params)=>{
  assertHostActive()
  if(!['send_private_msg','send_group_msg','send_poke'].includes(action))throw Error('outbox transport action denied')
  return transport(action,params,{timeoutMs:8000,singleAttempt:true})
 }})
 // Trusted remote server executes only the exact issued action; it cannot supply code
 // or manufacture an SDK agent to bypass wrapTool's actual-agent checks.
 const executeGrantedCall=(ticket,invocation)=>withToolPermit(ticket,invocation,()=>{const issued=tickets.get(ticket);return call(issued.request.action,issued.request.params)})
 return {moduleClient,outbound,grantTool,executeGrantedCall,wrapTool,wrapAutonomousTool,currentSignal:()=>context.getStore()?.exec?.signal,authorizationMode,audit:()=>fence(db=>db.prepare("SELECT op,action,session_id,call_id,holder,term,state,CASE WHEN approval_id LIKE 'autonomous:%' THEN 'autonomous' ELSE 'per-call' END AS authorization FROM tide_tool_permits ORDER BY op").all())}
}
