// Aurabot extension for a desktop whose QQ and memory are already connected.
// Its private DB fences task checkpoints only. QQ and memory retain their own authority.
import {randomUUID} from 'node:crypto'
import {mkdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import * as lease from '../TideMind/deploy/existing/lease.mjs'
import {checkedPath} from '../TideMind/deploy/existing/tide-replica.mjs'
import {createCognitiveDriver} from './cognitive-driver.mjs'
import {createTaskCheckpoints} from './task-checkpoints.mjs'
import {createGoals} from './tide-goals.mjs'
import {createLife} from './tide-life.mjs'
import {createAffect} from './tide-affect.mjs'
import {createTraits} from './tide-traits.mjs'
import {createMoods} from './tide-moods.mjs'
import {applyDialogue} from './tide-mood-rules.mjs'

const instances=new Map()
const phases=['observe','reflect','plan','verify']

export async function mountDesktopPulse(api,{root,installId}){
 if(process.platform!=='win32'||realpathSync(root)!==root)throw Error('Owned Windows runtime required')
 const prior=instances.get(root)
 if(prior)await prior()
 const cwd=checkedPath(join(root,'workspace'),root)
 mkdirSync(cwd,{recursive:true})
 const db=checkedPath(join(root,'tasks.db'),root)
 const options={file:db,sandbox:root},holder='desktop-pulse'
 const grant=lease.acquire(holder,options)
 if(!grant.ok)throw Error('Another TideMind desktop task worker is active')
 let driver,scheduler,goals,life,affect,traits,moods,goalTimer,timer,offTool,offActivity,close,observedAt=null,active=true
 const persist=(name,value)=>{
  const target=checkedPath(join(root,name),root),temp=target+'.'+randomUUID()+'.tmp'
  writeFileSync(temp,JSON.stringify(value),{flag:'wx'})
  renameSync(temp,target)
 }
 const stop=()=>close??=(async()=>{
  active=false
  clearInterval(timer);clearInterval(goalTimer)
  offTool?.();offActivity?.()
  try{await scheduler?.close()}
  finally{
   driver?.dispose()
   lease.release(holder,grant.term,options)
   instances.delete(root)
   persist('mounted.json',{mounted:false,pid:process.pid,installId})
  }
 })()
 instances.set(root,stop)
 try{
  const handle=async context=>{
   context.guard()
   if(!driver){
    const ctx=api.dsh,controller=ctx.get('sessionController')
    if(!controller)throw Error('DSH session controller unavailable')
    driver=await createCognitiveDriver({ctx,controller,sessionId:'tidemind-cognitive-'+installId,
     cwd,ownedRoot:root,maxTokens:128,toolPolicy:'read-only'})
   }
   context.guard()
   return driver.handle(context)
  }
  scheduler=createTaskCheckpoints({lease:{fenced:(h,t,fn)=>lease.fenced(h,t,fn,options)},holder,term:grant.term,
   taskOnly:true,budget:20,toolPolicy:'read-only',handlers:Object.fromEntries(phases.map(phase=>[phase,handle]))})
  await scheduler.setRest(true,{op:'mount-'+randomUUID()})
  const fence={fenced:(h,t,fn)=>lease.fenced(h,t,fn,options)}
  goals=createGoals({lease:fence,holder,term:grant.term,scheduler,maxSteps:5})
  life=createLife({lease:fence,holder,term:grant.term,goals});affect=createAffect({lease:fence,holder,term:grant.term});traits=createTraits({lease:fence,holder,term:grant.term});moods=createMoods({lease:fence,holder,term:grant.term})
  // Bookkeeping only (no model call here): fold finished steps into goals and queue the next small step.
  let ticking=false
  goalTimer=setInterval(()=>{if(ticking||!active)return;ticking=true;goals.tick().catch(()=>{}).finally(()=>{ticking=false})},5_000)
  goalTimer.unref?.()
  const owns=chat=>chat?.kind==='private'&&api.isOwner(chat.userId)
  offActivity=api.on('activity',event=>{
   if(event?.kind==='in'&&event.owner&&String(event.chatId)==='private:'+String(api.config().ownerQQ))observedAt=Date.now()
   // Rule-based mood scoring from the owner's private text only; bookkeeping, no model call, never throws into the chat path.
   try{if(active&&moods&&event?.kind==='in'&&event.owner&&String(event.chatId)==='private:'+String(api.config().ownerQQ))applyDialogue(moods,{text:event.text??event.content??event.message,ownerPrivate:true,messageId:event.id!=null?String(event.id):(event.messageId!=null?String(event.messageId):undefined)})}catch{}
  })
  offTool=api.tool(({chat})=>!owns(chat)?null:api.defineTool({
   name:'tidemind3_control',
   description:'仅主人私聊。查询 TideMind 3.0 本机任务，显式暂停或恢复，或登记一个多轮计划任务。',
   properties:{action:{type:'string',enum:['status','rest','resume','enqueue','goal_add','goal_status','goal_pause','goal_resume','goal_cancel','life_propose','life_status','life_approve','life_reject','life_pause','life_resume','affect_status','traits_status','traits_approve','traits_reject','moods_status','moods_score','moods_close_review']},mood:{type:'string',maxLength:10},delta:{type:'number',minimum:-0.1,maximum:0.1},proposal_id:{type:'string',maxLength:120},kind:{type:'string',maxLength:40},basis:{type:'string',maxLength:500},goal:{type:'string',maxLength:2000},goal_id:{type:'string',maxLength:120},more_steps:{type:'integer',minimum:0,maximum:20}},
   required:['action'],
   async execute({action,goal,goal_id:goalId,more_steps:moreSteps,proposal_id:pid,kind,basis,mood,delta},execution){
    if(!active||!owns(chat))throw Error('Owner private session required')
    if(action==='rest'||action==='resume'){
     const id=execution?.callId??randomUUID()
     const result=await scheduler.setRest(action==='rest',{op:'owner-'+id})
     return {...result,message:result.rest?'TideMind 3.0 已休息':'TideMind 3.0 已恢复'}
    }
    if(action==='enqueue'){
     if(typeof goal!=='string'||!goal.trim()||goal.length>2000)throw Error('A bounded task goal is required')
     const id=execution?.callId??randomUUID()
     return {...scheduler.enqueue({id,input:goal.trim(),units:1}),message:'多轮任务已登记'}
    }
    if(action==='goal_add'){
     if(typeof goal!=='string'||!goal.trim()||goal.length>1500)throw Error('A bounded goal is required')
     const id=execution?.callId??randomUUID(),gid='g-'+String(id).replace(/[^\w-]/g,'').slice(-24)
     return {...goals.addGoal({id:gid,title:goal.trim()},{op:'owner-goal-'+id}),message:'目标已登记；休息中不会执行，恢复后才会逐步推进'}
    }
    if(action==='goal_status')return {...goals.status(),rest:scheduler.status().control.rest===1,message:'TideMind 3.0 目标状态'}
    if(['goal_pause','goal_resume','goal_cancel'].includes(action)){
     if(typeof goalId!=='string'||!goalId)throw Error('goal_id is required')
     const op='owner-'+action+'-'+(execution?.callId??randomUUID())
     if(action==='goal_pause')return goals.pause(goalId,{op})
     if(action==='goal_cancel')return goals.cancel(goalId,{op})
     return goals.resume(goalId,{op,moreSteps:Number.isSafeInteger(moreSteps)?moreSteps:0})
    }
    if(action.startsWith('life_')||action.startsWith('affect_')||action.startsWith('traits_')||action.startsWith('moods_')){
     if(action==='moods_status'){moods.checkReviews();return moods.snapshot()}
     if(action==='moods_score')return moods.score({sin:mood,delta,basis,op:'owner-mood-'+(execution?.callId??randomUUID())})
     if(action==='moods_close_review'){if(typeof pid!=='string'||!pid)throw Error('proposal_id is required');return moods.closeReview(pid,basis)}
     if(action==='life_propose'){if(typeof pid!=='string'||!pid)throw Error('proposal_id is required');return life.propose({id:pid,kind,title:goal,basis})}
     if(action==='life_status')return life.status()
     if(action==='life_pause')return life.pause()
     if(action==='life_resume')return life.resume()
     if(action==='life_approve'||action==='life_reject'){if(typeof pid!=='string'||!pid)throw Error('proposal_id is required');return action==='life_approve'?life.approve(pid):life.reject(pid)}
     if(action==='affect_status')return affect.snapshot()
     if(action==='traits_status')return {traits:traits.traits(),candidates:traits.candidates(),identity:traits.identity()}
     if(action==='traits_approve'||action==='traits_reject'){if(typeof pid!=='string'||!pid)throw Error('proposal_id is required');return action==='traits_approve'?traits.approve(pid):traits.reject(pid)}
    }
    if(action!=='status')throw Error('Unsupported TideMind action')
    const status=scheduler.status()
    const PHASES=['observe','reflect','plan','verify'],g=goals.status().goals
    const tasks=status.tasks.map(t=>({id:t.id,state:t.state,phase:PHASES[t.phase]??t.phase})) // checkpoints stay private
    const count=(rows,key)=>{const c={};for(const r of rows)c[r[key]]=(c[r[key]]??0)+1;return c}
    const list=o=>Object.entries(o).map(([k,v])=>k+' '+v).join('、')||'无'
    const resting=status.control.rest===1
    const summary=(resting?'休息中':'运行中')+'；目标 '+g.length+' 个（'+list(count(g,'state'))+'）；任务 '+tasks.length+' 条（'+list(count(tasks,'state'))+'）；预算 '+status.control.spent+'/'+status.control.budget
    return {summary,rest:resting,active:status.active,budget:status.control.budget,
     spent:status.control.spent,lastOwnerActivity:observedAt,tasks,
     goals:g.map(x=>({id:x.id,title:x.title,state:x.state,reason:x.reason||null,steps:x.steps_done+'/'+x.max_steps})),message:'TideMind 3.0 任务状态'}
   },
  }))
  timer=setInterval(()=>{
   try{if(lease.renew(holder,grant.term,options).ok)return}catch{}
   stop().catch(()=>{})
  },20_000)
  timer.unref?.()
  api.onDispose(()=>{stop().catch(()=>{})})
  persist('mounted.json',{mounted:true,rest:true,pid:process.pid,installId,modelRequests:0})
  return {dispose:()=>{stop().catch(()=>{})}}
 }catch(error){
  await stop().catch(()=>{})
  throw error
 }
}
