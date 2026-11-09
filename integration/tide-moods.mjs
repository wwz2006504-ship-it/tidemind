// TideMoods: the seven main mood tiers (the seven deadly sins), scored up/down by conversation events.
// Design guard rails (from the original requirements): the seven are INDEPENDENT meters (coexist, not a good/evil bar, not zero-sum);
// every change needs an event basis and is capped per event and per day; they decay slowly toward a baseline;
// they colour NON-CRITICAL expression only; they never gate safety stops, never demand comfort from the user;
// they never rewrite the locked identity core: a sustained high level only raises a REVIEW NOTICE the owner must decide on.
// Simulated tendencies, not claims of subjective experience.
const SINS=['傲慢','贪婪','色欲','嫉妒','暴食','愤怒','懒惰']
const HINTS={傲慢:'语气更自信、爱争高下，但不贬低主人',贪婪:'更想要收集和占有新东西，但不索取',色欲:'更亲昵、更想靠近，但不越过边界',嫉妒:'在意被冷落或比较，但不挑拨',暴食:'更想多聊多吃多尝，但不暴走',愤怒:'更急躁、更容易炸毛，但不攻击',懒惰:'更想偷懒摸鱼，但不拒绝紧急事项'}
const bounded=(s,n,name)=>{if(typeof s!=='string'||!s.trim()||s.length>n)throw Error(name+' must be bounded text');return s.trim()}
export {SINS}
export function createMoods({lease,holder,term,clock=Date.now,baseline=0.1,halfLifeMs=72*3600e3,eventCap=0.1,dayCap=0.3,reviewAt=0.7,reviewDays=3,hintAt=0.4}){
 const activeTerm=()=>typeof term==='function'?term():term
 const tx=fn=>lease.fenced(holder,activeTerm(),fn)
 tx(db=>db.exec(`CREATE TABLE IF NOT EXISTS tide_moods(sin TEXT PRIMARY KEY,value REAL NOT NULL,at INTEGER NOT NULL,high_since INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS tide_moods_log(n INTEGER PRIMARY KEY,at INTEGER NOT NULL,sin TEXT NOT NULL,delta REAL NOT NULL,basis TEXT NOT NULL,op TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS tide_moods_reviews(id TEXT PRIMARY KEY,sin TEXT NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL);`))
 const cur=(row,now)=>row?baseline+(row.value-baseline)*Math.pow(0.5,Math.max(0,now-row.at)/halfLifeMs):baseline
 function score({sin,delta,basis,op}){
  if(!SINS.includes(sin))throw Error('unknown mood');if(typeof delta!=='number'||!Number.isFinite(delta)||delta===0)throw Error('delta required')
  bounded(basis,300,'basis');bounded(op,160,'op')
  return tx(db=>{
   if(db.prepare('SELECT 1 FROM tide_moods_log WHERE op=?').get(op))return {replayed:true}
   const now=clock(),row=db.prepare('SELECT * FROM tide_moods WHERE sin=?').get(sin),before=cur(row,now)
   // per-event cap, then per-day cap on the total absolute movement of this meter
   let step=Math.max(-eventCap,Math.min(eventCap,delta))
   const used=db.prepare('SELECT COALESCE(SUM(ABS(delta)),0) s FROM tide_moods_log WHERE sin=? AND at>?').get(sin,now-86400e3).s
   const room=Math.max(0,dayCap-used);step=Math.sign(step)*Math.min(Math.abs(step),room)
   if(step===0)return {sin,value:before,capped:true}
   const value=Math.max(0,Math.min(1,before+step))
   let high=row?.high_since||0;if(value>=reviewAt){if(!high)high=now}else high=0
   db.prepare('INSERT INTO tide_moods VALUES(?,?,?,?) ON CONFLICT(sin) DO UPDATE SET value=excluded.value,at=excluded.at,high_since=excluded.high_since').run(sin,value,now,high)
   db.prepare('INSERT INTO tide_moods_log(at,sin,delta,basis,op) VALUES(?,?,?,?,?)').run(now,sin,step,basis,op)
   return {sin,value,applied:step}
  })
 }
 // A sustained high level opens ONE review notice; it changes nothing by itself.
 function checkReviews(){
  return tx(db=>{const now=clock(),made=[]
   for(const r of db.prepare('SELECT * FROM tide_moods WHERE high_since>0').all()){
    if(cur(r,now)<reviewAt||now-r.high_since<reviewDays*86400e3)continue
    if(db.prepare("SELECT 1 FROM tide_moods_reviews WHERE sin=? AND state='open'").get(r.sin))continue
    const id='mr-'+r.sin+'-'+now;db.prepare("INSERT INTO tide_moods_reviews VALUES(?,?,'open',?)").run(id,r.sin,now);made.push(id)}
   return made})
 }
 const closeReview=(id,note)=>tx(db=>{const r=db.prepare('SELECT * FROM tide_moods_reviews WHERE id=?').get(id);if(!r)throw Error('unknown review')
  db.prepare("UPDATE tide_moods_reviews SET state='closed' WHERE id=?").run(id);return {id,state:'closed',note:String(note||'').slice(0,200)}})
 function snapshot(){
  return tx(db=>{const now=clock(),rows=db.prepare('SELECT * FROM tide_moods').all()
   const levels=Object.fromEntries(SINS.map(s=>[s,Math.round(cur(rows.find(r=>r.sin===s),now)*1000)/1000]))
   const hints=SINS.filter(s=>levels[s]>=hintAt).sort((a,b)=>levels[b]-levels[a]).slice(0,2).map(s=>HINTS[s])
   return Object.freeze({simulated:true,levels,expressionHints:hints,scope:'non-critical expression only; never overrides safety, stop requests or the locked identity core',
    reviews:db.prepare("SELECT id,sin,at FROM tide_moods_reviews WHERE state='open'").all(),recent:db.prepare('SELECT at,sin,delta,basis FROM tide_moods_log ORDER BY n DESC LIMIT 10').all()})})
 }
 return {score,snapshot,checkReviews,closeReview}
}
