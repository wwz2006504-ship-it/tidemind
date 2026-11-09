if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({dryRun:true,entry:"reconcile.mjs"})); process.exit(0) }
// 检索对账：同一批查询，分别在现役库（只读）和影子库（只读）上跑 FTS，比对结果。
// 只读；不写任何一边。判定：id 序列完全一致 + 内容哈希一致 = 通过。
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const LIVE = process.env.TIDEMIND_LIVE_DB; if (!LIVE) throw new Error('TIDEMIND_LIVE_DB required')
const SHADOW = process.env.TIDEMIND_DB; if (!SHADOW) throw new Error('TIDEMIND_DB required')

const QUERIES = [
  'rice',
  '老爹 生日',
  '耳朵 录音 麦克风',
  '影子库',
  '服务器 迁移',
  '记忆 备份',
  '女仆咖啡店',
  '健身 卧推',
]

const LIMIT = 20

function openRO(path) {
  return new DatabaseSync(path, { readOnly: true })
}

function search(db, q) {
  // 和 store.js 同构：trigram FTS + bm25 排序，只取 active 且未过期
  const sql =
    'SELECT m.id AS id, m.content AS content, bm25(memories_fts) AS rank ' +
    'FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid ' +
    "WHERE memories_fts MATCH ? AND m.status = 'active' AND m.valid_to IS NULL " +
    'ORDER BY rank LIMIT ?'
  // 和 store.js 一致：按空白切词，只留 >=3 字符的，OR 起来查（trigram 至少要三字）
  const terms = q.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 3).slice(0, 16)
  if (terms.length === 0) return []
  const ftsQuery = terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
  try {
    return db.prepare(sql).all(ftsQuery, LIMIT)
  } catch (e) {
    return { error: String(e.message || e) }
  }
}

function hash(rows) {
  return createHash('sha256').update(JSON.stringify(rows.map((r) => [r.id, r.content]))).digest('hex').slice(0, 16)
}

function metadata(db,id) {
 const row=db.prepare('SELECT id,layer,status,valid_to,superseded_by,updated_at,created_at,content,tags FROM memories WHERE id=?').get(id)
 if(!row)return null
 const {content,tags,...rest}=row
 return {...rest,contentHash:createHash('sha256').update(content).digest('hex'),tagsHash:createHash('sha256').update(tags).digest('hex')}
}
function diagnose(live,shadow,a,b) {
 const ids=[...new Set([...a,...b])]
 return ids.flatMap(id=>{
  const l=metadata(live,id),s=metadata(shadow,id)
  if(JSON.stringify(l)===JSON.stringify(s))return []
  const classification=!s&&l?'live-added-relative-to-shadow':
   !l&&s?'live-missing-review-required':
   l.status!==s.status||l.valid_to!==s.valid_to||l.superseded_by!==s.superseded_by?'state-change':
   l.contentHash!==s.contentHash?'content-change':'metadata-change'
  return [{id,classification,live:l,shadow:s}]
 })
}

const live = openRO(LIVE)
const shadow = openRO(SHADOW)
live.exec('PRAGMA query_only=ON; BEGIN')
shadow.exec('PRAGMA query_only=ON; BEGIN')

const report = { at: new Date().toISOString(), live: LIVE, shadow: SHADOW, limit: LIMIT, queries: [] }
let pass = 0
for (const q of QUERIES) {
  const a = search(live, q)
  const b = search(shadow, q)
  if (!Array.isArray(a) || !Array.isArray(b)) {
    report.queries.push({ q, ok: false, reason: 'error', live: a, shadow: b })
    continue
  }
  const idsA = a.map((r) => r.id)
  const idsB = b.map((r) => r.id)
  const sameOrder = idsA.length === idsB.length && idsA.every((id, i) => id === idsB[i])
  const sameContent = hash(a) === hash(b)
  const ok = sameOrder && sameContent
  if (ok) pass++
  report.queries.push({
    q,
    ok,
    liveCount: idsA.length,
    shadowCount: idsB.length,
    sameOrder,
    sameContent,
    differences: ok ? [] : diagnose(live, shadow, idsA, idsB),
    liveHash: hash(a),
    shadowHash: hash(b),
  })
}

report.summary = { total: QUERIES.length, pass, fail: QUERIES.length - pass }
live.close()
shadow.close()

const out = process.env.TIDEMIND_REPORT; if (!out) throw new Error('TIDEMIND_REPORT required')
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
if (report.summary.fail) process.exitCode = 1
console.log(JSON.stringify(report.summary))
for (const r of report.queries) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.q}  live=${r.liveCount} shadow=${r.shadowCount} order=${r.sameOrder} content=${r.sameContent}`)
}
console.log('report ->', out)
