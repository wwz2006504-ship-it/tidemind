// TideLife (Natural Life, Balanced): low-risk self-proposed goals, quiet hours, cooldowns, no nagging, global pause.
// Autonomy here is PROPOSE-ONLY: a self goal exists only after the owner approves it. Every decision is logged with its basis.
// Simulated preferences are not claims of subjective experience.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
const HOUR=3600e3
export const LOW_RISK=['memory-summary','reading','reflection','planning','tidy-notes']
const text=(s,max,name)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw Error(name+' must be bounded text');return s.trim()}
export function createLife({lease,holder,term,goals,clock=Date.now,config={}}){
 const cfg={quietStart:23,quietEnd:8,utcOffsetMin:-new Date().getTimezoneOffset(),proposalCooldownMs:6*HOUR,messageCooldownMs:6*HOUR,maxPending:3,...config}
 if(!goals||typeof goals.addGoal!=='function')throw Error('existing goals required')
 const activeTerm=()=>typeof term==='function'?term():term
 const tx=fn=>lease.fenced(holder,activeTerm(),fn)
 tx(db=>db.exec(`CREATE TABLE IF NOT EXISTS tide_life_state(k TEXT PRIMARY KEY,v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tide_life_proposals(id TEXT PRIMARY KEY,sig TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,basis TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tide_life_log(n INTEGER PRIMARY KEY,at INTEGER NOT NULL,action TEXT NOT NULL,allowed INTEGER NOT NULL,reason TEXT NOT NULL,basis TEXT NOT NULL);`))
 const getv=(db,k,d)=>{const r=db.prepare('SELECT v FROM tide_life_state WHERE k=?').get(k);return r?JSON.parse(r.v):d}
 const setv=(db,k,v)=>db.prepare('INSERT INTO tide_life_state VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,JSON.stringify(v))
 const log=(db,action,allowed,reason,basis)=>db.prepare('INSERT INTO tide_life_log(at,action,allowed,reason,basis) VALUES(?,?,?,?,?)').run(clock(),action,allowed?1:0,reason,String(basis||'').slice(0,500))
 const quiet=t=>{const h=Math.floor((((t/60e3+cfg.utcOffsetMin)/60)%24+24)%24);return cfg.quietStart>cfg.quietEnd?(h>=cfg.quietStart||h<cfg.quietEnd):(h>=cfg.quietStart&&h<cfg.quietEnd)}
 const deny=(db,action,reason,basis)=>{log(db,action,false,reason,basis);return {ok:false,reason}}
 function propose({id,kind,title,basis}){
  text(id,120,'id');text(basis,500,'basis');title=text(title,300,'title')
  return tx(db=>{
   const old=db.prepare('SELECT sig,state FROM tide_life_proposals WHERE id=?').get(id),sig=hash({id,kind,title})
   if(old){if(old.sig!==sig)throw Error('proposal conflict');return {ok:true,id,replayed:true,state:old.state}}
   const now=clock()
   if(getv(db,'paused',false))return deny(db,'propose','paused',basis)
   if(!LOW_RISK.includes(kind))return deny(db,'propose','not a low-risk kind',basis)
   if(quiet(now))return deny(db,'propose','quiet hours',basis)
   if(now-getv(db,'lastProposalAt',0)<cfg.proposalCooldownMs)return deny(db,'propose','proposal cooldown',basis)
   if(db.prepare("SELECT COUNT(*) c FROM tide_life_proposals WHERE state='proposed'").get().c>=cfg.maxPending)return deny(db,'propose','too many pending',basis)
   if(db.prepare("SELECT 1 FROM tide_life_proposals WHERE title=? AND state IN ('proposed','approved')").get(title))return deny(db,'propose','duplicate',basis)
   db.prepare("INSERT INTO tide_life_proposals VALUES(?,?,?,?,?,'proposed',?)").run(id,sig,kind,title,basis,now);setv(db,'lastProposalAt',now)
   log(db,'propose',true,'ok',basis);return {ok:true,id,state:'proposed'}
  })
 }
 // Owner decisions only. Approval turns a proposal into an ordinary low-priority goal.
 function decide(id,approve){
  const p=tx(db=>{const r=db.prepare('SELECT * FROM tide_life_proposals WHERE id=?').get(id);if(!r)throw Error('unknown proposal')
   if(r.state!=='proposed')return {...r,replayed:true}
   db.prepare('UPDATE tide_life_proposals SET state=? WHERE id=?').run(approve?'approved':'rejected',id);log(db,approve?'approve':'reject',true,'owner',r.basis);return r})
  if(approve&&!p.replayed)goals.addGoal({id:'life-'+id,title:p.title,source:'self',priority:1},{op:'life-'+id})
  return {id,state:approve?'approved':'rejected'}
 }
 const approve=id=>decide(id,true),reject=id=>decide(id,false)
 const pause=()=>tx(db=>{setv(db,'paused',true);log(db,'pause',true,'owner','')})
 const resume=()=>tx(db=>{setv(db,'paused',false);log(db,'resume',true,'owner','')})
 // Proactive chat messages: at most one unanswered at a time; a silent owner is never chased.
 function canSend(){
  return tx(db=>{const now=clock()
   if(getv(db,'paused',false))return deny(db,'send','paused','')
   if(quiet(now))return deny(db,'send','quiet hours','')
   if(getv(db,'unanswered',0)>=1)return deny(db,'send','waiting for a reply','')
   if(now-getv(db,'lastSentAt',0)<cfg.messageCooldownMs)return deny(db,'send','message cooldown','')
   return {ok:true}})
 }
 const noteSent=basis=>tx(db=>{setv(db,'lastSentAt',clock());setv(db,'unanswered',getv(db,'unanswered',0)+1);log(db,'sent',true,'ok',basis)})
 const noteOwnerReply=()=>tx(db=>setv(db,'unanswered',0))
 const status=()=>tx(db=>({paused:getv(db,'paused',false),unanswered:getv(db,'unanswered',0),proposals:db.prepare('SELECT id,kind,title,state,basis FROM tide_life_proposals ORDER BY created_at').all(),log:db.prepare('SELECT * FROM tide_life_log ORDER BY n DESC LIMIT 30').all()}))
 return {propose,approve,reject,pause,resume,canSend,noteSent,noteOwnerReply,status}
}
