if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({dryRun:true,entry:"tidemind-api.mjs"})); process.exit(0) }
// TideMind 检索服务（原型，只读影子库）
// 目标：给「检索入口」一个可验证的最小实现，远端 Hetzner 没开通前在 localhost 先跑。
// 约束：
//   - 只读打开影子库，任何写操作都不在代码里出现
//   - 只服务 agentId = xiyu；别的 agentId 一律空结果（不是报错，避免阻塞聊天）
//   - 默认不返回 valid_to 已过期的记录；带 history=1 且有权时才会搜历史
//   - 出错一律返回空记忆，不抛给调用方
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'


const PORT = Number(process.env.TIDEMIND_PORT || 5180)
const DB = process.env.TIDEMIND_DB || (() => {throw new Error('TIDEMIND_DB required')})()
const ALLOWED_AGENT = 'xiyu'

function openRO() {
  return new DatabaseSync(DB, { readOnly: true })
}

function terms(q) {
  return String(q || '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .slice(0, 16)
}

function retrieve({ agentId, query, limit = 6, history = 0 }) {
  if (agentId !== ALLOWED_AGENT) return { items: [], reason: 'agent-not-authorized' }
  const ts = terms(query)
  if (!ts.length) return { items: [], reason: 'empty-query' }
  const ftsQuery = ts.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
  if (history) return {items:[],reason:'history-authorization-required'}
  let db
  try {
    db = openRO()
    const sql =
      'SELECT m.id AS id, m.layer AS layer, m.category AS category, m.content AS content, ' +
      "m.created_at AS createdAt, m.updated_at AS updatedAt, m.valid_to AS validTo, bm25(memories_fts) AS score " +
      'FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid ' +
      "WHERE memories_fts MATCH ? AND m.status = 'active' " +
      (history ? '' : 'AND m.valid_to IS NULL ') +
      'ORDER BY score LIMIT ?'
    const rows = db.prepare(sql).all(ftsQuery, Math.min(50, Math.max(1, limit)))
    return {
      items: rows.map((r) => ({
        id: r.id,
        layer: r.layer,
        category: r.category,
        summary: String(r.content).slice(0, 120),
        source: r.id,
        validTo: r.validTo ?? null,
        score: r.score,
      })),
      reason: 'ok',
    }
  } catch (e) {
    return { items: [], reason: 'retrieve-unavailable' }
  } finally {
    db?.close()
  }
}

const server = createServer((req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, port: PORT })
  if (req.method !== 'POST' || req.url !== '/retrieve') return send(404, { ok: false })
  let raw = ''
  req.on('data', (c) => {
    raw += c
    if (raw.length > 64 * 1024) req.destroy()
  })
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      return send(200, { ok: true, items: [], reason: 'bad-json' })
    }
    const started = Date.now()
    let out
    try { out = retrieve(body ?? {}) } catch { out = {items:[],reason:'retrieve-unavailable'} }
    send(200, { ok: true, ...out, ms: Date.now() - started })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`tidemind api on http://127.0.0.1:${PORT}`)
})
