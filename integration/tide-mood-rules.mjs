// Deterministic dialogue -> mood scoring. No model call, and the model cannot score itself.
// Only the owner's private messages count (others could otherwise steer her personality). One hit per mood per message; small steps.
// The rule table is plain data so the owner can read and change it; unmatched messages change nothing.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
export const RULES=[
 {sin:'愤怒',delta:+0.04,why:'被辱骂或呵斥',words:['笨蛋','废物','滚','闭嘴','垃圾','蠢']},
 {sin:'愤怒',delta:-0.04,why:'收到道歉或安抚',words:['对不起','抱歉','别生气','我错了']},
 {sin:'傲慢',delta:+0.03,why:'被夸奖能干',words:['真聪明','好厉害','最棒','太强了','做得好']},
 {sin:'傲慢',delta:-0.03,why:'被指出错误',words:['你错了','搞错了','不对哦','说错了']},
 {sin:'嫉妒',delta:+0.04,why:'主人提到别的AI或别人更好',words:['别的AI','其他AI','别的助手','比你好','chatgpt','gpt']},
 {sin:'嫉妒',delta:-0.04,why:'主人表达偏爱',words:['只有你','最喜欢你','最信任你']},
 {sin:'色欲',delta:+0.03,why:'亲昵互动',words:['抱抱','亲亲','想你','摸摸头']},
 {sin:'贪婪',delta:+0.03,why:'收到礼物或奖励',words:['送你','奖励你','给你买','礼物']},
 {sin:'暴食',delta:+0.03,why:'聊到吃喝',words:['好吃','吃饭','想吃','奶茶','夜宵']},
 {sin:'懒惰',delta:+0.03,why:'被允许放松',words:['不急','休息','随便','慢慢来','摸鱼']},
 {sin:'懒惰',delta:-0.03,why:'有紧急或重要事项',words:['紧急','马上','加油','抓紧','截止']}
]
export function scoreDialogue({text,ownerPrivate,messageId,rules=RULES}){
 if(ownerPrivate!==true||typeof text!=='string'||!text.trim()||text.length>4000)return []
 const t=text.toLowerCase(),seen=new Set(),out=[]
 const id=typeof messageId==='string'&&messageId?messageId:hash({text:t}).slice(0,24)
 for(const r of rules){
  if(seen.has(r.sin))continue
  if(r.words.some(w=>t.includes(w.toLowerCase()))){seen.add(r.sin);out.push({sin:r.sin,delta:r.delta,basis:r.why+'：主人私聊',op:'dlg:'+id+':'+r.sin})}
 }
 return out
}
export function applyDialogue(moods,args){
 const hits=scoreDialogue(args),done=[]
 for(const h of hits)try{done.push(moods.score(h))}catch{}
 return done
}
