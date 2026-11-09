import test from 'node:test'
import assert from 'node:assert/strict'
import {controllerHost} from './controller-host.mjs'
import {createSessionHistoryReader} from './session-history.mjs'
import {createQQOutbound} from './qq-outbound.mjs'
test('real controller creates real agent and runs persisted inbox through actual loop',async()=>{
 const f=await controllerHost();try{
  assert.equal((await f.controller.resolveAgent(f.agent.id)).agent,f.agent)
  const outbound=createQQOutbound({...f,selfId:'10001',allowTargets:['private:20001'],transport:async()=>assert.fail(),historyReader:createSessionHistoryReader(f.ctx.sessionPersistence)})
  const event={post_type:'message',message_type:'private',self_id:10001,user_id:20001,message_id:1001,message:[{type:'text',data:{text:'麦克风'}}]}
  const {origin}=outbound.observeInbound(event,{chatId:'private:20001',userId:'20001',messageId:'1001'})
  await outbound.admitInput({sessionId:f.agent.id,chatId:'private:20001',origins:[origin],content:[{type:'text',text:'麦克风'}],followup:m=>f.agent.followup(m),flush:()=>f.ctx.sessions.flush(f.agent.session)})
  for(let i=0;i<200&&!f.agent.session.snapshotEvents().some(e=>e.type==='turn/end');i++)await new Promise(r=>setTimeout(r,5))
  assert.deepEqual(f.errors,[]);assert.ok(f.agent.session.snapshotEvents().some(e=>e.type==='assistant/message'));assert.equal(f.requests.length,1)
  assert.ok(JSON.stringify(f.requests[0].messages).includes('合成检索标记'))
 }finally{await f.cleanup()}
})
