// Native original/candidate comparison in a dedicated process. All writes and
// OneBot/TTS edges are synthetic; the original notes path is redirected in this
// process ONLY. No VM or source transformation is used to execute either module.
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {join,resolve,relative,isAbsolute} from 'node:path'
import assert from 'node:assert/strict'
const args=process.argv.slice(2)
if(args.includes('--dry-run')||args.includes('--rollback'))console.log(JSON.stringify({dryRun:args.includes('--dry-run'),rollback:args.includes('--rollback'),productionEnabled:false,rollbackAction:'probe owns temporary synthetic files only and removes them on exit'}))
else{
 const parent=resolve('data');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(join(parent,'chat-parity-'))
 const mkdir=fs.mkdirSync,append=fs.appendFileSync,originalRandom=Math.random,originalNotes='C:\\Users\\USERNAME\\WORKSPACE\\NOTES_DIR',noteBodies={reference:[],candidate:[]}
 const referenceNotes=join(root,'reference-notes'),candidateNotes=join(root,'candidate-notes')
 const inside=p=>{const r=relative(root,resolve(p));if(r.startsWith('..')||isAbsolute(r))throw Error('probe write outside synthetic root');return resolve(p)}
 const redirect=p=>{const text=String(p);return text===originalNotes?referenceNotes:text.startsWith(originalNotes+'\\')?join(referenceNotes,text.slice(originalNotes.length+1)):inside(text)}
 try{
  fs.mkdirSync=(p,...rest)=>mkdir(redirect(p),...rest)
  fs.appendFileSync=(p,body,...rest)=>{const target=redirect(p);const label=target.startsWith(referenceNotes)?'reference':target.startsWith(candidateNotes)?'candidate':null;if(label)noteBodies[label].push(String(body).replace(/- \d\d:\d\d ·/g,'- TIME ·'));return append(target,body,...rest)}
  syncBuiltinESMExports()
  process.env.TIDEMIND_SANDBOX_ROOT=root;process.env.TIDEMIND_AURABOT_WORKSPACE=join(root,'workspace');process.env.AURABOT_WORKSPACE=join(root,'workspace');process.env.TIDEMIND_SELF_NOTES_DIR=candidateNotes
  mkdir(candidateNotes);const wav=join(root,'synthetic.wav');fs.writeFileSync(wav,'SYNTHETIC AUDIO BYTES')
  const original=await import('../host/aurabot-upstream/src/chat/reply.js'),candidate=await import('../host/aurabot/src/chat/reply.js')
  const cases=['','[沉默]','［沉默］','普通合成回复','第一条|||第二条','一\n二\n三','1. 合成步骤\n2. 合成步骤','**粗体** 与 `代码`','<voice>合成声音</voice>','<sticker:合成>','<poke><poke>','<reply:1>合成引用|||<reply:2>第二引用','![合成](base64://U1lOVEhFVElD)','weekend END end 结束','<内心>合成私有意图</内心>公开回复','<内心>未闭合合成记录','盘算。 回：合成正文','<｜DSML｜calls>合成正文','一|||二|||三|||四|||五|||六']
  for(const text of cases)assert.deepEqual(candidate.parseReply(text),original.parseReply(text))
  for(const text of ['用语音说','不要语音','发个语音','普通文字'])assert.equal(candidate.wantsVoice(text),original.wantsVoice(text))
  for(const n of ['', '短', 'x'.repeat(100)])assert.equal(candidate.bubbleDelay(n,()=>.5),original.bubbleDelay(n,()=>.5))
  assert.deepEqual(noteBodies.candidate,noteBodies.reference)
  assert.ok(fs.readdirSync(candidateNotes).some(name=>/^\d{4}-\d{2}-\d{2}\.md$/.test(name)))
  assert.ok(!fs.readdirSync(root).some(name=>name.startsWith('candidate-notes\\')))
  const [{createHub:referenceHub},{createHub:candidateHub}]=await Promise.all([import('../host/aurabot-upstream/src/chat/hub.js'),import('../host/aurabot/src/chat/hub.js')])
  const scenarios=[{text:'合成文字'},{text:'一|||二|||三|||四',group:true},{text:'<voice>合成声音</voice>',voice:true},{text:'合成请求声音',voice:true,wantVoice:true},{text:'合成自动声音',voice:true,auto:true},{text:'<sticker:合成>',sticker:true},{text:'![合成](base64://U1lOVEhFVElD)'},{text:'<poke>'},{text:'[沉默]'},{text:'原文字',hooks:{reply:async()=> '模块改写的合成文字'}},{text:'合成取消',hooks:{reply:async()=>null}},{text:'原文字',hooks:{items:async()=>[{kind:'text',value:'模块气泡'}]}},{text:'合成暂停',disabled:true},{text:'合成试运行',dryRun:true}]
  async function run(createHub,which,scenario){
   const data=join(root,which+'-data');mkdir(data,{recursive:true});process.env.AURABOT_DATA_DIR=data;process.env.TIDEMIND_AURABOT_DATA_ROOT=data
   const packets=[],activities=[],used=[];const cfg={enabled:!scenario.disabled,dryRun:!!scenario.dryRun,botQQ:'10001',ownerQQ:'20001',voice:{enabled:!!scenario.voice,autoMaxChars:300,autoChance:scenario.auto?1:0},stickers:{enabled:!!scenario.sticker,autoChance:0},group:{overrides:{}}}
   const transport=async(action,params)=>{packets.push({action,params});return {message_id:90000+packets.length}}
   const outbound={validateItems:items=>{assert.ok(items.every(x=>['text','voice','sticker','image','poke'].includes(x.kind)))},withSendIntent:(_request,fn)=>fn(),send:async({chatId,message,pokeUserId})=>{const [kind,id]=chatId.split(':');return pokeUserId!==undefined?transport('send_poke',{user_id:pokeUserId,...(kind==='group'?{group_id:Number(id)}:{})}):transport(kind==='group'?'send_group_msg':'send_private_msg',{[kind==='group'?'group_id':'user_id']:Number(id),message})}}
   const sticker={md5:'synthetic',name:'SYNTHETIC'}
   const hub=createHub({dsh:{},getConfig:()=>cfg,log:{info(){},warn(){},debug(){},error(){}},onebot:{call:transport},tts:{speak:async()=>({file:wav,engine:'synthetic'})},stickers:{match:()=>sticker,pick:()=>sticker,pickForReply:()=>sticker,segmentFor:()=>({type:'image',data:{file:'base64://U1RJS0VS'}}),markUsed:id=>used.push(id)},hooks:scenario.hooks,moodEffects:()=>({voice:1,sticker:1,chatty:1,delay:0}),onActivity:value=>activities.push(value),...(which==='candidate'?{outbound}:{})})
   Math.random=()=>.5
   const result=await hub.deliver(scenario.group?'group:30001':'private:20001',scenario.text,{wantVoice:scenario.wantVoice})
   const snapshot={packets,activities,used,result,stats:hub.stats(),ownerText:hub.lastBotToOwner.text,hasLastChat:hub.lastChatAt>0}
   hub.dispose?.();return snapshot
  }
  for(const scenario of scenarios)assert.deepEqual(await run(candidateHub,'candidate',scenario),await run(referenceHub,'reference',scenario))
  console.log(JSON.stringify({passed:true,parserCases:cases.length,deliveryCases:scenarios.length,nativeOriginal:true,originalNotesPathRedirected:true,realQQ:false,realTTS:false,productionEnabled:false}))
 }finally{Math.random=originalRandom;fs.mkdirSync=mkdir;fs.appendFileSync=append;syncBuiltinESMExports();const r=relative(parent,root);if(!r||r.startsWith('..')||isAbsolute(r))throw Error('unsafe probe cleanup');fs.rmSync(root,{recursive:true,force:true})}
}
