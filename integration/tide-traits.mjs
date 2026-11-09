// TideTraits: slow-moving tendencies, independent dimensions (not good/evil bars, not zero-sum).
// A change needs several RELIABLE experiences, is rate-limited, and only ever becomes a CANDIDATE that the owner must approve.
// Identity core is locked: changing it needs explicit confirmation, keeps every version, and can be reverted. Growth is never a rewrite.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
export const TRAITS=['好奇','谨慎','勇敢','主动','坚持']
const bounded=(s,n,name)=>{if(typeof s!=='string'||!s.trim()||s.length>n)throw Error(name+' must be bounded text');return s.trim()}
export function createTraits({lease,holder,term,clock=Date.now,needed=5,cooldownMs=7*86400e3,step=0.02,initial=0.5}){
 const activeTerm=()=>typeof term==='function'?term():term
 const tx=fn=>lease.fenced(holder,activeTerm(),fn)
 tx(db=>{db.exec(`CREATE TABLE IF NOT EXISTS tide_traits(trait TEXT PRIMARY KEY,value REAL NOT NULL,last_change INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tide_trait_evidence(n INTEGER PRIMARY KEY,trait TEXT NOT NULL,direction INTEGER NOT NULL,basis TEXT NOT NULL,op TEXT NOT NULL UNIQUE,used INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS tide_trait_candidates(id TEXT PRIMARY KEY,trait TEXT NOT NULL,direction INTEGER NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tide_identity_core(v INTEGER PRIMARY KEY,text TEXT NOT NULL,at INTEGER NOT NULL,reason TEXT NOT NULL,current INTEGER NOT NULL);`)
  for(const t of TRAITS)db.prepare('INSERT OR IGNORE INTO tide_traits VALUES(?,?,0)').run(t,initial)})
 // Only reliable (verified, repeated-source) experiences count; unreliable ones are ignored, not stored as evidence.
 function record({trait,direction,reliable,basis,op}){
  if(!TRAITS.includes(trait)||![1,-1].includes(direction))throw Error('trait and direction required')
  bounded(basis,300,'basis');bounded(op,160,'op')
  if(reliable!==true)return {counted:false,reason:'not reliable'}
  return tx(db=>{
   if(db.prepare('SELECT 1 FROM tide_trait_evidence WHERE op=?').get(op))return {replayed:true}
   const now=clock();db.prepare('INSERT INTO tide_trait_evidence(trait,direction,basis,op) VALUES(?,?,?,?)').run(trait,direction,basis,op)
   const rows=db.prepare('SELECT direction FROM tide_trait_evidence WHERE trait=? AND used=0').all(trait)
   const net=rows.reduce((a,r)=>a+r.direction,0)
   const pending=db.prepare("SELECT 1 FROM tide_trait_candidates WHERE trait=? AND state='proposed'").get(trait)
   const last=db.prepare('SELECT last_change FROM tide_traits WHERE trait=?').get(trait).last_change
   if(Math.abs(net)>=needed&&!pending&&now-last>=cooldownMs){
    const id='tc-'+hash({trait,now,net}).slice(0,16);db.prepare("INSERT INTO tide_trait_candidates VALUES(?,?,?,'proposed',?)").run(id,trait,Math.sign(net),now);return {counted:true,candidate:id}
   }
   return {counted:true}
  })
 }
 const decide=(id,approve)=>tx(db=>{const c=db.prepare('SELECT * FROM tide_trait_candidates WHERE id=?').get(id);if(!c)throw Error('unknown candidate')
  if(c.state!=='proposed')return {id,state:c.state,replayed:true};const now=clock()
  db.prepare('UPDATE tide_trait_candidates SET state=? WHERE id=?').run(approve?'approved':'rejected',id)
  db.prepare('UPDATE tide_trait_evidence SET used=1 WHERE trait=? AND used=0').run(c.trait)
  if(approve)db.prepare('UPDATE tide_traits SET value=MIN(1,MAX(0,value+?)),last_change=? WHERE trait=?').run(c.direction*step,now,c.trait)
  else db.prepare('UPDATE tide_traits SET last_change=? WHERE trait=?').run(now,c.trait)
  return {id,state:approve?'approved':'rejected'}})
 const approve=id=>decide(id,true),reject=id=>decide(id,false)
 const traits=()=>tx(db=>Object.fromEntries(db.prepare('SELECT trait,value FROM tide_traits').all().map(r=>[r.trait,Math.round(r.value*1000)/1000])))
 const candidates=()=>tx(db=>db.prepare('SELECT * FROM tide_trait_candidates ORDER BY at').all())
 // Identity core.
 const identity=()=>tx(db=>db.prepare('SELECT v,text,at,reason FROM tide_identity_core WHERE current=1').get()||null)
 function setIdentity({text,reason,confirmed}){
  bounded(text,4000,'identity');bounded(reason,300,'reason')
  if(confirmed!==true)throw Error('identity change needs explicit owner confirmation')
  return tx(db=>{const cur=db.prepare('SELECT v,text FROM tide_identity_core WHERE current=1').get()
   if(cur&&cur.text===text)return {v:cur.v,unchanged:true}
   const v=(db.prepare('SELECT MAX(v) m FROM tide_identity_core').get().m||0)+1
   db.prepare('UPDATE tide_identity_core SET current=0').run();db.prepare('INSERT INTO tide_identity_core VALUES(?,?,?,?,1)').run(v,text,clock(),reason);return {v}})
 }
 function revertIdentity(v,{confirmed}={}){
  if(confirmed!==true)throw Error('identity revert needs explicit owner confirmation')
  return tx(db=>{const t=db.prepare('SELECT v FROM tide_identity_core WHERE v=?').get(v);if(!t)throw Error('unknown identity version')
   db.prepare('UPDATE tide_identity_core SET current=0').run();db.prepare('UPDATE tide_identity_core SET current=1 WHERE v=?').run(v);return {v}})
 }
 const history=()=>tx(db=>db.prepare('SELECT v,reason,at,current FROM tide_identity_core ORDER BY v').all())
 return {record,approve,reject,traits,candidates,identity,setIdentity,revertIdentity,history}
}
