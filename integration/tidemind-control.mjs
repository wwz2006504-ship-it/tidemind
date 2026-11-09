// Owner-private controls hosted by the original Aurabot module kernel.
import {createHash} from 'node:crypto'
export default {
 id:'tidemind-control',name:'潮池任务控制',version:'1.0.0',
 setup(api){
  api.tool(({chat,level})=>{
   if(chat.kind!=='private'||level!=='full'||!api.isOwner(chat.userId))return []
   return [api.defineTool({name:'tidemind_control',description:'查看任务状态、休息、恢复主动任务或加入有预算的任务。休息保留正常聊天；drained=false表示仍在停止中，不能说已经完全停止。',properties:{action:{type:'string',enum:['status','rest','resume','enqueue']},input:{type:'string'},units:{type:'integer',minimum:1,maximum:20}},required:['action'],execute:async(args,exec)=>{
    if(!exec?.agent?.session?.id||!exec.callId)throw Error('actual owner tool invocation required')
    const id=createHash('sha256').update(JSON.stringify([exec.agent.session.id,exec.callId])).digest('hex')
    if(args.action==='status')return {ok:true,...await api.core.tidemind.status()}
    if(['rest','resume'].includes(args.action))return api.core.tidemind.requestRest(args.action==='rest',{op:'control:'+id})
    if(args.action==='enqueue'){if(typeof args.input!=='string'||!args.input.trim())throw Error('nonempty task input required');return {ok:true,...await api.core.tidemind.enqueue({id:'owner:'+id,input:args.input,units:args.units??1})}}
    throw Error('unknown task control action')
   }})]
  })
  api.rule(kind=>kind==='private'?'想休息时可以用 tidemind_control rest 停止主动任务，正常聊天仍然保留。恢复用 resume；查看 status 的 drained 状态确认是否真正停完。':'')
  return {}
 },
}
