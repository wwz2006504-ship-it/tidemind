// TideAffect: short-lived SIMULATED emotion state. Not a claim of subjective experience.
// Each state has inertia (a single event moves it only a little), exponential decay, and an event basis.
// The seven main intensity levels of the original design are NOT defined here (not invented); only the eight named special states.
// It may colour non-critical wording/choices. It never gates safety stops, never demands comfort, never addresses the user.
import {hash} from '../TideMind/deploy/existing/tide-gateway.mjs'
export const EMOTIONS=['委屈','害怕','好奇','尴尬','开心','感动','失落','愧疚']
const HALF_LIFE_MS=3*3600e3,MAX_STEP=0.25
const bounded=(s,n,name)=>{if(typeof s!=='string'||!s.trim()||s.length>n)throw Error(name+' must be bounded text');return s.trim()}
export function createAffect({lease,holder,term,clock=Date.now,halfLifeMs=HALF_LIFE_MS}){
 const activeTerm=()=>typeof term==='function'?term():term
 const tx=fn=>lease.fenced(holder,activeTerm(),fn)
 tx(db=>db.exec(`CREATE TABLE IF NOT EXISTS tide_affect(emotion TEXT PRIMARY KEY,value REAL NOT NULL,at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS tide_affect_log(n INTEGER PRIMARY KEY,at INTEGER NOT NULL,emotion TEXT NOT NULL,delta REAL NOT NULL,basis TEXT NOT NULL,op TEXT NOT NULL UNIQUE);`))
 const decayed=(row,now)=>row?row.value*Math.pow(0.5,Math.max(0,now-row.at)/halfLifeMs):0
 function apply({emotion,delta,basis,op}){
  if(!EMOTIONS.includes(emotion))throw Error('unknown emotion')
  if(typeof delta!=='number'||!Number.isFinite(delta)||delta===0)throw Error('delta required')
  bounded(basis,300,'basis');bounded(op,160,'op')
  return tx(db=>{
   if(db.prepare('SELECT 1 FROM tide_affect_log WHERE op=?').get(op))return {replayed:true}
   const now=clock(),row=db.prepare('SELECT * FROM tide_affect WHERE emotion=?').get(emotion)
   const step=Math.max(-MAX_STEP,Math.min(MAX_STEP,delta)),value=Math.max(0,Math.min(1,decayed(row,now)+step))
   db.prepare('INSERT INTO tide_affect VALUES(?,?,?) ON CONFLICT(emotion) DO UPDATE SET value=excluded.value,at=excluded.at').run(emotion,value,now)
   db.prepare('INSERT INTO tide_affect_log(at,emotion,delta,basis,op) VALUES(?,?,?,?,?)').run(now,emotion,step,basis,op)
   return {emotion,value}
  })
 }
 function snapshot(){
  return tx(db=>{const now=clock(),rows=db.prepare('SELECT * FROM tide_affect').all()
   const states=Object.fromEntries(EMOTIONS.map(e=>[e,Math.round(decayed(rows.find(r=>r.emotion===e),now)*1000)/1000]))
   const top=Object.entries(states).filter(([,v])=>v>=0.1).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([e])=>e)
   return Object.freeze({simulated:true,states,dominant:top,affects:'non-critical wording only',
    recent:db.prepare('SELECT at,emotion,delta,basis FROM tide_affect_log ORDER BY n DESC LIMIT 10').all()})})
 }
 return {apply,snapshot}
}
