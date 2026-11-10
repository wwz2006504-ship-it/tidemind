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
// 2026-11-09：活句柄放在 globalThis，不放这个模块的闭包里。
// 模块重载会 import 出一份新的 desktop-pulse.mjs（闭包全新的），可 DSH 会话里挂着的
// 工具可能是上一份闭包生成的旧对象。旧对象如果只认自己的 goals/affect，模块一换它
// 就对着已 stop 的实例干活（active=false，永远报「Owner private session required」）。
// 所以工具执行的入口改成“每次调用都去 globalThis 取当前实例的句柄”——改名不再是前提。
const HANDLE_KEY=Symbol.for('tidemind.desktop-pulse.handles')
const live=new Map()
globalThis[HANDLE_KEY]??=live
const handles=globalThis[HANDLE_KEY]

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
 const token=randomUUID()
 let driver,scheduler,goals,life,affect,traits,moods,goalTimer,timer,offTool,offRoute,offActivity,close,observedAt=null,active=true
 const persist=(name,value)=>{
  const target=checkedPath(join(root,name),root),temp=target+'.'+randomUUID()+'.tmp'
  writeFileSync(temp,JSON.stringify(value),{flag:'wx'})
  renameSync(temp,target)
 }
 // 把四个子系统的真实数值摊平：面板和 status 都读这一个函数，口径只有一份。
 const readings=()=>{
  const a=affect.snapshot(),m=moods.snapshot(),l=life.status(),s=scheduler.status()
  return {
   at:Date.now(),
   rest:s.control.rest===1,
   budget:{spent:s.control.spent,budget:s.control.budget},
   affect:{simulated:true,states:a.states,dominant:a.dominant,events:a.recent.length,
    note:a.recent.length?'由对话/事件写入':'还没有输入源：没有任何代码调用 affect.apply，所以全是 0'},
   moods:{levels:m.levels,hints:m.expressionHints,openReviews:m.reviews.length,events:m.recent.length,
    note:m.recent.length?'由主人私聊的规则表写入':"还没有输入源：applyDialogue 只在主人私聊命中关键词时才写"},
   traits:{values:traits.traits(),candidates:traits.candidates().length,
    note:'只有可靠经历累积到阈值才会出候选，候选要主人批准才动值'},
   life:{paused:l.paused,unanswered:l.unanswered,proposals:l.proposals.length,log:l.log.length,
    note:'提案制：自己不立项，只提给主人批'},
   tasks:(s.tasks||[]).map(t=>({id:t.id,state:t.state,phase:t.phase,attempt:t.attempt})),
   goals:(goals.status().goals||[]).map(g=>({id:g.id,title:String(g.title||'').slice(0,80),state:g.state,steps:(g.steps_done??0)+'/'+(g.max_steps??0),reason:g.reason||''})),
   lastOwnerActivity:observedAt,
  }
 }
 const top=(obj,n=3)=>Object.entries(obj).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,v])=>k+' '+v.toFixed(2)).join('／')||'全 0'
 const stop=()=>close??=(async()=>{
  active=false
  clearInterval(timer);clearInterval(goalTimer)
  offTool?.();offRoute?.();offActivity?.()
  if(handles.get(root)?.token===token)handles.delete(root)
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
     cwd,ownedRoot:root,maxTokens:128,toolPolicy:'existing'})
   }
   context.guard()
   return driver.handle(context)
  }
  scheduler=createTaskCheckpoints({lease:{fenced:(h,t,fn)=>lease.fenced(h,t,fn,options)},holder,term:grant.term,
   taskOnly:true,budget:20,toolPolicy:'existing',handlers:Object.fromEntries(phases.map(phase=>[phase,handle]))})
  await scheduler.setRest(true,{op:'mount-'+randomUUID()})
  const fence={fenced:(h,t,fn)=>lease.fenced(h,t,fn,options)}
  goals=createGoals({lease:fence,holder,term:grant.term,scheduler,maxSteps:5})
  life=createLife({lease:fence,holder,term:grant.term,goals});affect=createAffect({lease:fence,holder,term:grant.term});traits=createTraits({lease:fence,holder,term:grant.term});moods=createMoods({lease:fence,holder,term:grant.term})
  // 注册当前实例的活句柄（旧闭包也能找到这里）
  handles.set(root,{token,root,api,installId,get active(){return active},get observedAt(){return observedAt},
   get scheduler(){return scheduler},get goals(){return goals},get life(){return life},get affect(){return affect},
   get traits(){return traits},get moods(){return moods},readings})
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
  // 面板数据口：/aurabot/api/ext/tidemind3-pulse/state
  if(typeof api.route==='function')offRoute=api.route('/state',async()=>({ok:true,installId,...(handles.get(root)?.readings?.()??{})}))
  offTool=api.tool(({chat})=>!owns(chat)?null:api.defineTool({
   name:'tidemind3_control',
   description:'仅主人私聊。查询 TideMind 3.0 本机任务与 affect/moods/traits/life 的当前数值，显式暂停或恢复，或登记一个多轮计划任务。',
   properties:{action:{type:'string',enum:['status','rest','resume','enqueue','goal_add','goal_status','goal_pause','goal_resume','goal_cancel','life_propose','life_status','life_approve','life_reject','life_pause','life_resume','affect_status','traits_status','traits_approve','traits_reject','moods_status','moods_score','moods_close_review']},mood:{type:'string',maxLength:10},delta:{type:'number',minimum:-0.1,maximum:0.1},proposal_id:{type:'string',maxLength:120},kind:{type:'string',maxLength:40},basis:{type:'string',maxLength:500},goal:{type:'string',maxLength:2000},goal_id:{type:'string',maxLength:120},more_steps:{type:'integer',minimum:0,maximum:20}},
   required:['action'],
   async execute({action,goal,goal_id:goalId,more_steps:moreSteps,proposal_id:pid,kind,basis,mood,delta},execution){
    // 活句柄：模块重载后，旧工具对象也必须打到新实例上，否则永远是「已停止」的旧闭包。
    const H=handles.get(root)
    if(!H||!H.active)throw Error('TideMind 3.0 没在跑（模块停了或还没起来）')
    if(!owns(chat))throw Error('Owner private session required')
    if(action==='rest'||action==='resume'){
     const id=execution?.callId??randomUUID()
     const result=await H.scheduler.setRest(action==='rest',{op:'owner-'+id})
     return {...result,message:result.rest?'TideMind 3.0 已休息':'TideMind 3.0 已恢复'}
    }
    if(action==='enqueue'){
     if(typeof goal!=='string'||!goal.trim()||goal.length>2000)throw Error('A bounded task goal is required')
     const id=execution?.callId??randomUUID()
     return {...H.scheduler.enqueue({id,input:goal.trim(),units:1}),message:'多轮任务已登记'}
    }
    if(action==='goal_add'){
     if(typeof goal!=='string'||!goal.trim()||goal.length>1500)throw Error('A bounded goal is required')
     const id=execution?.callId??randomUUID(),gid='g-'+String(id).replace(/[^\w-]/g,'').slice(-24)
     return {...H.goals.addGoal({id:gid,title:goal.trim()},{op:'owner-goal-'+id}),message:'目标已登记；休息中不会执行，恢复后才会逐步推进'}
    }
    if(action==='goal_status')return {...H.goals.status(),rest:H.scheduler.status().control.rest===1,message:'TideMind 3.0 目标状态'}
    if(['goal_pause','goal_resume','goal_cancel'].includes(action)){
     if(typeof goalId!=='string'||!goalId)throw Error('goal_id is required')
     const op='owner-'+action+'-'+(execution?.callId??randomUUID())
     if(action==='goal_pause')return H.goals.pause(goalId,{op})
     if(action==='goal_cancel')return H.goals.cancel(goalId,{op})
     return H.goals.resume(goalId,{op,moreSteps:Number.isSafeInteger(moreSteps)?moreSteps:0})
    }
    if(action.startsWith('life_')||action.startsWith('affect_')||action.startsWith('traits_')||action.startsWith('moods_')){
     if(action==='moods_status'){H.moods.checkReviews();return {...H.moods.snapshot(),message:'心情：'+top(H.moods.snapshot().levels)}}
     if(action==='moods_score')return H.moods.score({sin:mood,delta,basis,op:'owner-mood-'+(execution?.callId??randomUUID())})
     if(action==='moods_close_review'){if(typeof pid!=='string'||!pid)throw Error('proposal_id is required');return H.moods.closeReview(pid,basis)}
     if(action==='life_propose'){if(typeof pid!=='string'||!pid)throw Error('proposal_id is required');return H.life.propose({id:pid,kind,title:goal,basis})}
     if(action==='life_status')return H.life.status()
     if(action==='life_pause')return H.life.pause()
     if(action==='life_resume')return H.life.resume()
     if(action==='life_approve'||action==='life_reject'){if(typeof pid!=='string'||!pid)throw Error('proposal_id is required');return action==='life_approve'?H.life.approve(pid):H.life.reject(pid)}
     if(action==='affect_status'){const a=H.affect.snapshot();return {...a,message:'情绪：'+top(a.states)}}
     if(action==='traits_status'){const t=H.traits.traits();return {traits:t,candidates:H.traits.candidates(),identity:H.traits.identity(),message:'性格：'+top(t,5)}}
     if(action==='traits_approve'||action==='traits_reject'){if(typeof pid!=='string'||!pid)throw Error('proposal_id is required');return action==='traits_approve'?H.traits.approve(pid):H.traits.reject(pid)}
    }
    if(action!=='status')throw Error('Unsupported TideMind action')
    const status=H.scheduler.status(),r=H.readings()
    // 2026-11-09：status 以前只给一行标题，目标 blocked 也看不出原因，被当成「空的」。
    const goalList=(H.goals.status().goals||[]).map(g=>({id:g.id,title:String(g.title||'').slice(0,80),state:g.state,reason:g.reason||undefined}))
    const taskList=(status.tasks||[]).map(t=>({id:t.id,state:t.state,phase:t.phase,attempt:t.attempt}))
    const summary=[status.control.rest===1?'休息中':'运行中',
     goalList.length?('目标 '+goalList.length+' 个：'+goalList.map(g=>g.state).join('/')):'没有登记过目标',
     taskList.length?('任务 '+taskList.length+' 条'):'没有任务',
     '预算 '+status.control.spent+'/'+status.control.budget,
     '情绪 '+top(r.affect.states),'心情 '+top(r.moods.levels),'性格 '+top(r.traits.values,5),
     '生活 '+(r.life.paused?'暂停':'正常')+' 提案'+r.life.proposals].join('｜')
    return {rest:status.control.rest===1,active:status.active,budget:status.control.budget,
     spent:status.control.spent,lastOwnerActivity:observedAt,tasks:taskList,goals:goalList,summary,
     readings:r,message:'TideMind 3.0 任务状态：'+summary}
   },
  }))
  timer=setInterval(()=>{
   try{if(lease.renew(holder,grant.term,options).ok)return}catch{}
   stop().catch(()=>{})
  },20_000)
  timer.unref?.()
  api.onDispose(()=>{stop().catch(()=>{})})
  persist('mounted.json',{mounted:true,rest:true,pid:process.pid,installId,modelRequests:0,token})
  return {dispose:()=>{stop().catch(()=>{})},readings}
 }catch(error){
  await stop().catch(()=>{})
  throw error
 }
}
