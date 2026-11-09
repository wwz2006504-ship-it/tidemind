// Actual SDK execution scope around original module definitions; no fabricated agent.
import {AsyncLocalStorage} from 'node:async_hooks'
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
import {classifyQQAction} from './onebot-capabilities.mjs'
import {assertCognitiveActive,denyCognitiveSideEffect} from './activity-gate.mjs'
export function createRemoteQQToolScope({qq,assertHostActive,outbound}){
 if(typeof qq?.callTool!=='function'||typeof qq?.read!=='function'||typeof assertHostActive!=='function')throw Error('explicit remote QQ and host lifecycle guard required')
 const context=new AsyncLocalStorage()
 function guard(scope){assertHostActive();assertCognitiveActive();if(scope){if(!scope.active)throw Error('original tool invocation ended');scope.exec.signal?.throwIfAborted();scope.guard?.()}}
 const moduleClient=Object.freeze({async call(action,params={},options={}){
  const scope=context.getStore();guard(scope)
  const kind=classifyQQAction(action)
  if(kind==='send'){
   if(!outbound||!['send_private_msg','send_group_msg','send_poke'].includes(action))throw Error('remote chat sends require original bound outbox')
   const group=action==='send_group_msg'||action==='send_poke'&&params.group_id!==undefined,allowed=action==='send_poke'?['user_id','group_id']:group?['group_id','message']:['user_id','message']
   if(Object.keys(params).some(k=>!allowed.includes(k))||Object.keys(options).some(k=>k!=='timeoutMs')||options.timeoutMs!==undefined&&(!Number.isFinite(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>30000))throw Error('unsupported bound send request')
   const id=Number(group?params.group_id:params.user_id);if(!Number.isSafeInteger(id)||id<=0)throw Error('explicit send target required');const chatId=(group?'group:':'private:')+id
   return outbound.send(action==='send_poke'?{chatId,pokeUserId:Number(params.user_id)}:{chatId,message:typeof params.message==='string'?[{type:'text',data:{text:params.message}}]:params.message})
  }
  if(kind==='read'){const result=await qq.read(action,params,options);guard(scope);return result}
  denyCognitiveSideEffect();if(!scope)throw Error('actual original tool invocation required')
  if(Object.keys(options).length)throw Error('remote tool transport options require reviewed binding')
  const {agent,callId}=scope.exec,op='autonomous:'+hash([agent.session.id,callId,action,scope.sequence++])
  const result=await qq.callTool({op,sessionId:agent.session.id,callId,action,params});guard(scope);return result
 }})
 function wrapTool(definition,{guard:hostGuard}={}){
  if(typeof definition?.execute!=='function')throw Error('original executable tool required')
  return {...definition,execute:async(args,exec)=>{
   if(!exec?.agent?.id||exec.agent.id!==exec.agent.session?.id||typeof exec.callId!=='string'||!exec.callId)throw Error('actual SDK tool identity required')
   const scope={exec,active:true,sequence:0,guard:hostGuard};guard(scope)
   try{return await context.run(scope,()=>definition.execute(args,exec))}finally{scope.active=false}
  }}
 }
 const currentFrame=()=>{const scope=context.getStore();if(!scope)return null;guard(scope);const {agent,callId}=scope.exec,turn=agent.session.snapshotEvents?.().findLast(e=>e.type==='turn/start')?.data?.turn??agent.turn;if(!Number.isSafeInteger(turn)||turn<1)throw Error('actual bound tool turn required');return {sessionId:agent.session.id,callId,turn,sequence:scope.sequence++,guard:()=>guard(scope)}}
 return Object.freeze({moduleClient,wrapTool,currentFrame,currentSignal:()=>context.getStore()?.exec?.signal})
}
