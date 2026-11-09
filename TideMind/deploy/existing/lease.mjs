if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({dryRun:true,entry:"lease.mjs"})); process.exit(0) }
// 主实例租约：同一时间只许一个实例回 QQ、写正式记忆。
// 规则：带过期时间的租约 + 递增任期编号。只有持有有效租约的实例才能提交。
import { DatabaseSync } from 'node:sqlite'
import { resolve, relative, isAbsolute } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
const authorityScope = new AsyncLocalStorage()

const DEFAULTS = {
  get file() {
    if (!process.env.TIDEMIND_LEASE_DB) throw new Error('TIDEMIND_LEASE_DB required; isolated new database only')
    return process.env.TIDEMIND_LEASE_DB
  },
  ttl: 60_000,
}

export function openAuthority(file = DEFAULTS.file, sandbox = process.env.TIDEMIND_SANDBOX_ROOT) {
  if (!sandbox) throw new Error('TIDEMIND_SANDBOX_ROOT required')
  const root = realpathSync(sandbox)
  for (const protectedRoot of ['<MEMORY_LAYERS_DIR>','C:/Users/USERNAME/Aurabot/qq-chats/tidemind-shadow','<MEMORY_LAYERS_DIR_2>']) {
    const r = relative(resolve(protectedRoot),root)
    if (!r || (!r.startsWith('..') && !isAbsolute(r))) throw new Error('existing production/shadow directory prohibited')
  }
  const target = existsSync(file) ? realpathSync(file) : resolve(realpathSync(resolve(file, '..')), file.split(/[\\/]/).pop())
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('lease path outside synthetic root')
  if (existsSync(file)) {
    const probe = new DatabaseSync(file,{readOnly:true})
    try {
      const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name)
      if (names.some(n=>n!=='lease'&&!n.startsWith('tide_'))) throw new Error('not an isolated lease database')
      { const KNOWN=new Set(['lease','tide_head','tide_log','tide_outbox','tide_handover','tide_identity','tide_inbox','tide_qq_turns','tide_qq_receipts','tide_input_journal','tide_admissions','tide_input_payloads','tide_input_recovery','tide_task_control','tide_tasks','tide_task_ops','tide_task_log','tide_goals','tide_goal_steps','tide_life_state','tide_life_proposals','tide_life_log','tide_affect','tide_affect_log','tide_traits','tide_trait_evidence','tide_trait_candidates','tide_identity_core','tide_moods','tide_moods_log','tide_moods_reviews','tide_tool_permits','tide_qq_actions','tide_sync_receipts','tide_sync_signatures','tide_sidecar_states','tide_sidecar_log','tide_transfer_tickets','tide_memory_barrier','tide_memory_barrier_ops','tide_source_gate','tide_source_deferred','tide_source_callbacks','tide_history_head','tide_transfer_custody']); for (const n of names) if (n.startsWith('tide_')&&!KNOWN.has(n)&&!globalThis.__tideWarned?.has(n)) { (globalThis.__tideWarned??=new Set()).add(n); console.warn('[tidemind] unlisted table allowed by tide_ prefix: '+n) } }

    } finally { probe.close() }
  }
  const db = new DatabaseSync(file)
  try {
  db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      holder TEXT,
      term INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO lease (id, holder, term, expires_at, updated_at) VALUES (1, NULL, 0, 0, 0);
  `)
  return db
  } catch(error) { db.close(); throw error }
}

export function status(file = DEFAULTS.file) {
  const db = new DatabaseSync(file, {readOnly:true})
  const row = db.prepare('SELECT holder, term, expires_at, updated_at FROM lease WHERE id = 1').get()
  db.close()
  const now = Date.now()
  return { ...row, now, valid: !!row.holder && row.expires_at > now && row.updated_at <= now }
}

/** 抢租约：空闲或已过期才抢得到，抢到任期 +1。 */
export function acquire(holder, { file = DEFAULTS.file, sandbox, ttl = DEFAULTS.ttl, requireHome = false } = {}) {
  if (!holder || !Number.isFinite(ttl) || ttl <= 0) return {ok:false,reason:'invalid-arguments'}
  const db = openAuthority(file,sandbox)
  try {
    db.exec('BEGIN IMMEDIATE')
    if(requireHome && db.prepare('SELECT home FROM tide_head WHERE id = 1').get()?.home!==holder){
      db.exec('ROLLBACK')
      return {ok:false,reason:'standby-home'}
    }
    const now = Date.now()
    const row = db.prepare('SELECT holder, term, expires_at, updated_at FROM lease WHERE id = 1').get()
    if(row.updated_at>now){db.exec('ROLLBACK');return {ok:false,reason:'clock-regression'}}
    const free = !row.holder || row.expires_at <= now
    if (!free) {
      db.exec('ROLLBACK')
      return { ok: false, holder: row.holder, term: row.term, expiresAt: row.expires_at, reason: 'held' }
    }
    const term = row.term + 1
    const expiresAt = now + ttl
    db.prepare('UPDATE lease SET holder = ?, term = ?, expires_at = ?, updated_at = ? WHERE id = 1').run(holder, term, expiresAt, now)
    db.exec('COMMIT')
    return { ok: true, holder, term, expiresAt }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    return { ok: false, reason: 'error:' + String(e.message || e) }
  } finally {
    db.close()
  }
}

/** 续期：holder + term 都对、且没过期才续得上。 */
export function renew(holder, term, { file = DEFAULTS.file, sandbox, ttl = DEFAULTS.ttl } = {}) {
  if (!holder || !Number.isInteger(term) || !Number.isFinite(ttl) || ttl <= 0) return {ok:false,reason:'invalid-arguments'}
  const db = openAuthority(file,sandbox)
  try {
    const now = Date.now(), expiresAt = now + ttl
    const result = db.prepare('UPDATE lease SET expires_at=?,updated_at=? WHERE id=1 AND holder=? AND term=? AND expires_at>? AND updated_at<=?').run(expiresAt,now,holder,term,now,now)
    return result.changes === 1 ? {ok:true,holder,term,expiresAt} : {ok:false,reason:'not-owner-or-expired'}
  } finally { db.close() }
}

/** 让位：只有当前持有者能主动交出去。 */
export function release(holder, term, { file = DEFAULTS.file, sandbox } = {}) {
  const db = openAuthority(file,sandbox)
  try {
    const result = db.prepare('UPDATE lease SET holder=NULL,expires_at=0,updated_at=? WHERE id=1 AND holder=? AND term=?').run(Date.now(),holder,term)
    return result.changes === 1 ? {ok:true,releasedBy:holder,term} : {ok:false,reason:'not-owner'}
  } finally { db.close() }
}

// Exclusive authority transaction: the check and durable acceptance are one commit.
export function fenced(holder, term, callback, {file=DEFAULTS.file,sandbox,allowReleased=false}={}) {
  const borrowed=authorityScope.getStore()
  if(borrowed?.active&&borrowed.file===resolve(file)){
    if(borrowed.holder!==holder||borrowed.term!==term)throw new Error('FENCED')
    const check=()=>{const row=borrowed.db.prepare('SELECT * FROM lease WHERE id=1').get();if(row.holder!==holder||row.term!==term||row.expires_at<=Date.now()||row.updated_at>Date.now())throw new Error('FENCED')}
    check();const result=callback(borrowed.db)
    if(result&&typeof result.then==='function')throw new Error('asynchronous callback forbidden inside authority transaction')
    check();return result
  }
  const db=openAuthority(file,sandbox)
  const scope={file:resolve(file),db,holder,term,active:true}
  try {
    db.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE')
    const check=()=>{
      const row=db.prepare('SELECT * FROM lease WHERE id=1').get()
      if(row.holder!==holder || row.term!==term || row.expires_at<=Date.now() || row.updated_at>Date.now()) throw new Error('FENCED')
    }
    check()
    const result=authorityScope.run(scope,()=>callback(db))
    if(result && typeof result.then==='function') throw new Error('asynchronous callback forbidden inside authority transaction')
    const final=db.prepare('SELECT holder,term,expires_at FROM lease WHERE id=1').get()
    if(!(allowReleased&&final.holder===null&&final.term===term&&final.expires_at===0))check()
    db.exec('COMMIT');return result
  }catch(error){try{db.exec('ROLLBACK')}catch{};throw error}
  finally{scope.active=false;db.close()}
}

// Original admin operations retained. `serve` is transport for THIS authority.
if (process.argv[1] && process.argv[1].endsWith('lease.mjs')) {
 const [cmd,a,b]=process.argv.slice(2)
 if(cmd==='serve') {
   const {serveAuthority}=await import('./tide-authority.mjs')
   const options=a==='--wiring' ? await (await import('../../../integration/authority-wiring.mjs')).loadAuthorityWiring(b) : {}
   if(a&&a!=='--wiring')throw Error('Unknown authority serve option')
   const server=serveAuthority({acquire,renew,release,status,fenced,openAuthority},options)
   if(options.startTransports){
     server.once('listening',options.startTransports)
     server.once('close',options.stopTransports)
     for(const signal of ['SIGTERM','SIGINT']){
       process.once(signal,()=>server.close())
     }
   }
 } else {
   const out=cmd==='acquire'?acquire(a,{ttl:b?Number(b):undefined}):cmd==='renew'?renew(a,Number(b)):cmd==='release'?release(a,Number(b)):status()
   console.log(JSON.stringify(out))
 }
}
