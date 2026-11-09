
/**
 * dsh-memory-layers - SQLite-backed layered memory store.
 *
 * Layers: core / episodic / semantic / working.
 * Persona lives in its own table so identity text can never be confused with
 * a factual memory row. Everything is plain SQLite (node:sqlite, built into
 * Node >= 22.5) so a backup is one file and migration is trivial.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const LAYERS = Object.freeze(['core', 'episodic', 'semantic', 'working'])
export const STATUSES = Object.freeze(['active', 'pending', 'superseded', 'withdrawn'])
export const SOURCES = Object.freeze(['user', 'auto', 'tool', 'import'])

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE TABLE IF NOT EXISTS memories (',
  '  rowid INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  id TEXT NOT NULL UNIQUE,',
  '  layer TEXT NOT NULL,',
  "  category TEXT NOT NULL DEFAULT 'fact',",
  '  content TEXT NOT NULL,',
  '  key TEXT,',
  "  tags TEXT NOT NULL DEFAULT '[]',",
  '  importance INTEGER NOT NULL DEFAULT 3,',
  '  confidence REAL NOT NULL DEFAULT 1.0,',
  "  status TEXT NOT NULL DEFAULT 'active',",
  "  source TEXT NOT NULL DEFAULT 'user',",
  '  source_session TEXT,',
  '  source_turn INTEGER,',
  '  source_ref TEXT,',
  '  created_at INTEGER NOT NULL,',
  '  updated_at INTEGER NOT NULL,',
  '  valid_from INTEGER,',
  '  valid_to INTEGER,',
  '  superseded_by TEXT,',
  '  conflict_with TEXT,',
  '  norm_hash TEXT NOT NULL,',
  "  meta TEXT NOT NULL DEFAULT '{}'",
  ');',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_norm ON memories(layer, norm_hash) WHERE status IN (\'active\', \'pending\');',
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_mem_key ON memories(layer, key) WHERE key IS NOT NULL AND status = 'active';",
  'CREATE INDEX IF NOT EXISTS ix_mem_layer_status ON memories(layer, status, updated_at DESC);',
  'CREATE INDEX IF NOT EXISTS ix_mem_updated ON memories(updated_at DESC);',
  'CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, tokenize=\'trigram\', content=\'memories\', content_rowid=\'rowid\');',
  'CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN',
  '  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);',
  'END;',
  'CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN',
  '  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES (\'delete\', old.rowid, old.content, old.tags);',
  'END;',
  'CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, tags ON memories BEGIN',
  '  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES (\'delete\', old.rowid, old.content, old.tags);',
  '  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);',
  'END;',
  'CREATE TABLE IF NOT EXISTS persona (key TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);',
  'CREATE TABLE IF NOT EXISTS persona_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, reason TEXT);',
  'CREATE TABLE IF NOT EXISTS memory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, memory_id TEXT, layer TEXT, detail TEXT NOT NULL DEFAULT \'{}\');',
  'CREATE TABLE IF NOT EXISTS retrieval_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, query TEXT NOT NULL, items INTEGER NOT NULL, chars INTEGER NOT NULL, est_tokens INTEGER NOT NULL, source TEXT NOT NULL DEFAULT \'context\');'
].join('\n')

const STOP = new Set([
  '我的', '你的', '我是', '你是', '他的', '她的', '我们', '你们', '他们',
  '什么', '怎么', '为什么', '这个', '那个', '一下', '帮我', '请问', '可以',
  '不是', '就是', '还是', '但是', '因为', '所以', '然后', '现在', '已经',
  '一个', '没有', '知道', '觉得', '时候', '今天', '明天', '昨天', '的话',
  '的', '了', '吗', '呢', '啊', '吧', '呀', '是', '在', '有', '和', '就',
  '不', '都', '也', '很', '还', '要', '会', '能', '我', '你', '他', '她'
])

/** Remove characters that carry no retrieval value. Keeps digits and CJK. */
export function normalizeText(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？；：、,.!?;:'"“”‘’()（）\[\]【】<>《》—\-_/\\|@#$%^&*+=~]+/g, '')
}

export function normHash(text) {
  return createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 32)
}

/** Character-bigram Jaccard similarity, tuned for Chinese and short facts. */
export function similarity(a, b) {
  const A = bigramSet(a)
  const B = bigramSet(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

function negationCount(text) {
  const m = String(text).match(/不|没|别|未|停止|取消/g)
  return m === null ? 0 : m.length
}

function numbersOf(text) {
  return (String(text).match(/\d+(?:\.\d+)?/g) ?? []).join(',')
}

/** Conflict is about polarity or changed values, not mere wording similarity. */
export function isPotentialConflict(a, b) {
  const sim = similarity(a, b)
  if (sim >= 0.9) return true
  if (sim < 0.6) return false
  if (negationCount(a) !== negationCount(b)) return true
  const na = numbersOf(a)
  const nb = numbersOf(b)
  return na !== '' && nb !== '' && na !== nb
}

function bigramSet(text) {
  const s = normalizeText(text)
  const out = new Set()
  if (s.length === 1) out.add(s)
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/** Terms used by both retrieval and relevance scoring. */
export function extractTerms(query) {
  const text = String(query ?? '').normalize('NFKC')
  const terms = []
  const push = (t) => {
    const v = t.trim().toLowerCase()
    if (v.length < 2 || STOP.has(v) || terms.includes(v)) return
    terms.push(v)
  }
  const addFrom = (sentence) => {
    for (const m of sentence.matchAll(/[a-z0-9][a-z0-9_.:/-]{1,}/gi)) push(m[0])
    for (const m of sentence.matchAll(/[\u3400-\u9fff]+/g)) {
      const run = m[0]
      if (run.length <= 6) push(run)
      if (run.length > 2) {
        for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2))
      }
    }
  }
  // Long user turns mix instructions with a real question. Rank sentences so
  // the question's terms reach the front of the capped list; otherwise a long
  // preamble can crowd out the only words that identify the memory.
  const sentences = text.split(/[。！？!?\n；;]+/).map((x) => x.trim()).filter((x) => x !== '')
  const ranked = sentences.map((sentence, index) => {
    const question = /[?？]|什么|哪|谁|怎么|如何|多少|吗|是否|是不是/.test(sentence)
    const lengthScore = sentence.length <= 120 ? 1 : 0.4
    return { sentence, score: (question ? 3 : 0) + lengthScore + index / Math.max(1, sentences.length) * 0.5 }
  }).sort((a, b) => b.score - a.score)
  const source = ranked.length > 0 ? ranked : [{ sentence: text }]
  for (const item of source) {
    addFrom(item.sentence)
    if (terms.length >= 32) break
  }
  return terms.slice(0, 32)
}

/** Estimated tokens. Explicitly an estimate: CJK ~1 token/char, latin ~4 chars/token. */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  let latin = 0
  let other = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk++
    else if (/[A-Za-z0-9]/.test(ch)) latin++
    else other++
  }
  return Math.ceil(cjk + latin / 4 + other / 4)
}

function nowMs() { return Date.now() }
function isoDay(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}
function stamp(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
}

function makeId(now) {
  return 'm_' + now.toString(36) + '_' + randomBytes(4).toString('hex')
}

function json(value, fallback) {
  try { return JSON.parse(value) } catch { return fallback }
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean)
  return String(value ?? '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
}

function clampInt(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function safeLayer(layer) {
  return LAYERS.includes(layer) ? layer : 'semantic'
}

/** One open store. Reopen on restore; all methods read this.db. */
export class MemoryStore {
  constructor(dir, options = {}) {
    this.dir = dir
    this.dbPath = join(dir, 'memory.db')
    this.backupDir = join(dir, 'backups')
    this.exportDir = join(dir, 'exports')
    this.keepBackups = clampInt(options.keepBackups, 1, 100, 7)
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(this.backupDir, { recursive: true })
    mkdirSync(this.exportDir, { recursive: true })
    this.open()
    this.migrate()
  }

  open() {
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;')
  }

  migrate() {
    this.db.exec(SCHEMA)
    this.setMeta('schema_version', '1')
  }

  close() {
    try { this.db.close() } catch (error) { void error }
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)
    return row?.value
  }

  event(action, memoryId, layer, detail) {
    this.db.prepare('INSERT INTO memory_events(at,action,memory_id,layer,detail) VALUES(?,?,?,?,?)')
      .run(nowMs(), action, memoryId ?? null, layer ?? null, JSON.stringify(detail ?? {}))
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollbackError) { void rollbackError }
      throw error
    }
  }

  /** Write or update one persona slot. Persona is stored separately from facts. */
  writePersona(input, now = nowMs()) {
    const key = String(input.key ?? 'self').trim() || 'self'
    const content = String(input.content ?? '').trim()
    if (content === '') throw new Error('persona content is empty')
    return this.tx(() => {
      const current = this.db.prepare('SELECT * FROM persona WHERE key=?').get(key)
      if (current && current.active === 1 && current.content === content) {
        return { action: 'duplicate', key, version: current.version, note: '人格设定未变化，没有产生新版本。' }
      }
      const version = (current?.version ?? 0) + 1
      if (current) {
        this.db.prepare('UPDATE persona SET content=?, version=?, active=1, updated_at=? WHERE key=?')
          .run(content, version, now, key)
      } else {
        this.db.prepare('INSERT INTO persona(key,content,version,active,updated_at) VALUES(?,?,?,1,?)')
          .run(key, content, version, now)
      }
      this.db.prepare('INSERT INTO persona_versions(key,content,version,at,reason) VALUES(?,?,?,?,?)')
        .run(key, content, version, now, String(input.reason ?? ''))
      this.event(current ? 'persona.revised' : 'persona.created', key, 'core', { version })
      return { action: current ? 'revised' : 'created', key, version, note: '人格设定已单独保存，不参与事实检索。' }
    })
  }

  readPersona(includeInactive = false) {
    const rows = this.db.prepare('SELECT * FROM persona ' + (includeInactive ? '' : 'WHERE active=1') + ' ORDER BY key').all()
    return rows.map((r) => ({ key: r.key, content: r.content, version: r.version, active: r.active === 1, updatedAt: r.updated_at }))
  }

  /** Add a memory. Dedup and slot supersession run inside one transaction. */
  write(input, now = nowMs()) {
    const layer = safeLayer(String(input.layer ?? 'semantic'))
    const content = String(input.content ?? '').trim()
    if (content === '') return { action: 'rejected', note: '记忆内容不能为空。' }
    if (content.length > 8000) return { action: 'rejected', note: '单条记忆过长，请拆分成多条。' }
    if (layer === 'core' && String(input.category ?? '') === 'persona') {
      return this.writePersona({ key: input.key, content, reason: input.source_ref }, now)
    }

    const key = input.key === undefined || input.key === null || String(input.key).trim() === ''
      ? null
      : String(input.key).trim()
    const category = String(input.category ?? 'fact').trim() || 'fact'
    const tags = parseTags(input.tags)
    const importance = clampInt(input.importance, 1, 5, 3)
    const confidence = Math.min(1, Math.max(0, Number(input.confidence ?? 1) || 0))
    const source = SOURCES.includes(input.source) ? input.source : 'tool'
    let status = STATUSES.includes(input.status) ? input.status : 'active'
    const norm = normHash(content)
    const auto = source === 'auto'

    return this.tx(() => {
      if (key !== null) {
        const old = this.db.prepare(
          "SELECT * FROM memories WHERE layer=? AND key=? AND status='active' LIMIT 1"
        ).get(layer, key)
        if (old) {
          if (old.norm_hash === norm) {
            this.db.prepare('UPDATE memories SET updated_at=?, importance=MAX(importance,?), tags=? WHERE rowid=?')
              .run(now, importance, JSON.stringify(mergeTags(json(old.tags, []), tags)), old.rowid)
            return { action: 'duplicate', id: old.id, note: '同一槽位已是相同内容，只更新了时间与重要度。' }
          }
          this.db.prepare(
            "UPDATE memories SET status='superseded', valid_to=?, superseded_by=?, updated_at=? WHERE rowid=?"
          ).run(now, null, now, old.rowid)
          this.event('memory.superseded', old.id, layer, { reason: 'same key new value' })
        }
      }

      const dup = this.db.prepare(
        "SELECT * FROM memories WHERE layer=? AND norm_hash=? AND status IN ('active','pending') LIMIT 1"
      ).get(layer, norm)
      if (dup) {
        this.db.prepare('UPDATE memories SET updated_at=?, importance=MAX(importance,?), tags=?, confidence=MAX(confidence,?) WHERE rowid=?')
          .run(now, importance, JSON.stringify(mergeTags(json(dup.tags, []), tags)), confidence, dup.rowid)
        return { action: 'duplicate', id: dup.id, note: '相同事实已存在，已合并标签与时间，未新增重复记录。' }
      }

      // Only automatic capture is cautious about near-duplicate conflicts. A
      // manual tool write is an explicit decision and stays active.
      let conflictWith = null
      if (auto && status === 'active' && key === null) {
        const candidates = this.db.prepare(
          "SELECT * FROM memories WHERE layer=? AND category=? AND status='active' AND length(content) BETWEEN ? AND ? ORDER BY updated_at DESC LIMIT 40"
        ).all(layer, category, Math.max(2, content.length - 12), content.length + 12)
        for (const c of candidates) {
          if (c.norm_hash === norm) continue
          if (isPotentialConflict(c.content, content)) { conflictWith = c.id; status = 'pending'; break }
        }
      }

      const id = makeId(now)
      this.db.prepare('INSERT INTO memories(id,layer,category,content,key,tags,importance,confidence,status,source,source_session,source_turn,source_ref,created_at,updated_at,valid_from,conflict_with,norm_hash,meta) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, layer, category, content, key, JSON.stringify(tags), importance, confidence, status, source,
        input.source_session ?? null, input.source_turn ?? null, input.source_ref ?? null,
        now, now, now, conflictWith, norm, JSON.stringify(input.meta ?? {})
      )
      this.event('memory.created', id, layer, { status, category, source, conflictWith })
      return {
        action: 'created',
        id,
        status,
        note: conflictWith
          ? '与已有记忆高度相似但内容不同，已放入待审核区，避免覆盖旧事实。'
          : '已写入。'
      }
    })
  }

  /** Update an existing row by id. Content revisions keep the old events. */
  update(id, patch = {}, now = nowMs()) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(String(id))
    if (!row) return { action: 'rejected', note: '找不到记忆 ' + id }
    const content = patch.content === undefined ? row.content : String(patch.content).trim()
    if (content === '') return { action: 'rejected', note: '记忆内容不能为空。' }
    const status = patch.status === undefined ? row.status : String(patch.status)
    if (!STATUSES.includes(status)) return { action: 'rejected', note: '未知状态 ' + status }
    const tags = patch.tags === undefined ? json(row.tags, []) : parseTags(patch.tags)
    const importance = patch.importance === undefined ? row.importance : clampInt(patch.importance, 1, 5, row.importance)
    const confidence = patch.confidence === undefined ? row.confidence : Math.min(1, Math.max(0, Number(patch.confidence)))
    const norm = normHash(content)

    return this.tx(() => {
      if (norm !== row.norm_hash) {
        const dup = this.db.prepare(
          "SELECT id FROM memories WHERE layer=? AND norm_hash=? AND status IN ('active','pending') AND id<>? LIMIT 1"
        ).get(row.layer, norm, row.id)
        if (dup) return { action: 'duplicate', id: dup.id, note: '更新后的内容与另一条记忆重复，已拒绝本次修改。' }
      }
      this.db.prepare("UPDATE memories SET content=?, tags=?, importance=?, confidence=?, status=?, norm_hash=?, updated_at=?, valid_to=CASE WHEN ?='active' THEN NULL ELSE COALESCE(valid_to,?) END WHERE id=?")
        .run(content, JSON.stringify(tags), importance, confidence, status, norm, now, status, now, row.id)
      this.event('memory.updated', row.id, row.layer, { from: row.status, to: status })
      return { action: 'updated', id: row.id, status, note: '已更新。' }
    })
  }

  /** Hard delete by id or query. FTS rows are removed by trigger; caller clears caches. */
  forget(args = {}) {
    const ids = []
    if (args.id) ids.push(String(args.id))
    if (args.query) {
      const found = this.search(String(args.query), { layers: args.layers, limit: args.limit ?? 20, includePending: true })
      for (const item of found.items) ids.push(item.id)
    }
    const unique = [...new Set(ids)]
    if (unique.length === 0) return { action: 'nothing', deleted: 0, note: '没有匹配到可删除的记忆。' }
    const deleted = []
    this.tx(() => {
      for (const id of unique) {
        const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id)
        if (!row) continue
        this.db.prepare('DELETE FROM memories WHERE id=?').run(id)
        this.event('memory.deleted', id, row.layer, { norm_hash: row.norm_hash, category: row.category })
        deleted.push({ id, layer: row.layer, category: row.category })
      }
    })
    return { action: 'deleted', deleted: deleted.length, ids: deleted.map((x) => x.id), note: '已从主表和全文索引删除。' }
  }

  /** Hard-delete one persona slot and its version history. Only a hash is audited. */
  forgetPersona(key) {
    const k = String(key ?? '').trim()
    if (k === '') return { action: 'rejected', note: '需要 persona_key' }
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM persona WHERE key=?').get(k)
      if (!row) return { action: 'nothing', deleted: 0, note: '没有这个 persona 槽位。' }
      this.db.prepare('DELETE FROM persona WHERE key=?').run(k)
      this.db.prepare('DELETE FROM persona_versions WHERE key=?').run(k)
      this.event('persona.deleted', k, 'core', { version: row.version })
      return { action: 'deleted', deleted: 1, key: k, note: '人格槽位及其历史版本已删除。' }
    })
  }

  list(args = {}) {
    const where = []
    const params = []
    if (args.layer) { where.push('layer=?'); params.push(safeLayer(args.layer)) }
    if (args.status) { where.push('status=?'); params.push(String(args.status)) }
    if (args.category) { where.push('category=?'); params.push(String(args.category)) }
    const limit = clampInt(args.limit, 1, 200, 30)
    const sql = 'SELECT * FROM memories ' + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC LIMIT ?'
    params.push(limit)
    return this.db.prepare(sql).all(...params).map(publicRow)
  }

  /** Search the store. Returns scored, deduplicated, budget-trimmed items. */
  search(query, args = {}) {
    const q = String(query ?? '').trim()
    const layers = Array.isArray(args.layers) && args.layers.length > 0 ? args.layers.map(safeLayer) : null
    const limit = clampInt(args.limit, 1, 50, 8)
    const includePending = args.includePending === true
    const maxChars = clampInt(args.maxChars, 40, 20000, 4000)
    const terms = extractTerms(q)
    const rows = new Map()

    const acceptStatus = (includePending ? "status IN ('active','pending')" : "status='active'") + ' AND valid_to IS NULL'
    const layerClause = layers ? ' AND layer IN (' + layers.map(() => '?').join(',') + ')' : ''
    const baseParams = layers ?? []

    if (q !== '') {
      const ftsTerms = terms.filter((t) => t.length >= 3).slice(0, 16)
      if (ftsTerms.length > 0) {
        const ftsQuery = ftsTerms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' OR ')
        try {
          const got = this.db.prepare(
            'SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts ' +
            'JOIN memories m ON m.rowid = memories_fts.rowid ' +
            'WHERE memories_fts MATCH ? AND ' + acceptStatus + layerClause + ' ORDER BY rank LIMIT 300'
          ).all(ftsQuery, ...baseParams)
          for (const r of got) rows.set(r.id, r)
        } catch (ftsError) { void ftsError }
      }
      const likeTerms = terms.length > 0 ? terms : [q]
      const likeClauses = likeTerms.slice(0, 24).map(() => "(content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')")
      const likeParams = []
      for (const t of likeTerms.slice(0, 24)) {
        const pattern = '%' + t.replace(/[\\%_]/g, '\\$&') + '%'
        likeParams.push(pattern, pattern)
      }
      const got = this.db.prepare(
        'SELECT * FROM memories WHERE ' + acceptStatus + layerClause + ' AND (' + likeClauses.join(' OR ') + ') ' +
        'ORDER BY importance DESC, updated_at DESC LIMIT 300'
      ).all(...baseParams, ...likeParams)
      for (const r of got) rows.set(r.id, r)
    }

    const scored = []
    const now = nowMs()
    for (const row of rows.values()) {
      const hay = (row.content + ' ' + (row.tags ?? '')).toLowerCase()
      const matched = terms.filter((t) => hay.includes(t)).length
      const phrase = q !== '' && hay.includes(q.toLowerCase()) ? 1 : 0
      const textScore = terms.length === 0 ? 0 : Math.min(1, matched / Math.max(2, Math.min(terms.length, 6)))
      const ageDays = Math.max(0, (now - row.updated_at) / 86400000)
      const recency = Math.exp(-ageDays / 180)
      const layerBoost = row.layer === 'core' ? 0.12 : row.layer === 'working' ? 0.08 : 0
      const score = 0.55 * textScore + 0.2 * (row.importance / 5) + 0.13 * recency + 0.12 * phrase + layerBoost
      scored.push({ row, score, matched, textScore })
    }
    const filtered = q === '' ? scored : scored.filter((x) => x.matched > 0 && (x.matched >= Math.min(2, terms.length) || x.textScore >= 0.5))
    filtered.sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at)

    const seen = new Set()
    const items = []
    let chars = 0
    for (const item of filtered) {
      if (seen.has(item.row.norm_hash)) continue
      const out = { ...publicRow(item.row), score: Number(item.score.toFixed(3)) }
      const cost = out.content.length + 40
      if (items.length >= limit || chars + cost > maxChars) continue
      seen.add(item.row.norm_hash)
      chars += cost
      items.push(out)
    }
    return { total: filtered.length, items, query: q, terms }
  }

  /** Core memory for the always-on slice, capped by characters. */
  core(limitChars = 800) {
    const rows = this.db.prepare(
      "SELECT * FROM memories WHERE layer='core' AND status='active' AND valid_to IS NULL ORDER BY importance DESC, updated_at DESC LIMIT 40"
    ).all()
    const out = []
    let chars = 0
    for (const r of rows) {
      if (r.category === 'persona') continue
      if (chars + r.content.length > limitChars) break
      chars += r.content.length + 8
      out.push(publicRow(r))
    }
    return out
  }

  working(limit = 2, limitChars = 400) {
    const rows = this.db.prepare(
      "SELECT * FROM memories WHERE layer='working' AND status='active' AND valid_to IS NULL ORDER BY updated_at DESC LIMIT ?"
    ).all(clampInt(limit, 1, 10, 2))
    const out = []
    let chars = 0
    for (const r of rows) {
      if (chars + r.content.length > limitChars) break
      chars += r.content.length + 8
      out.push(publicRow(r))
    }
    return out
  }

  /**
   * 潮池退潮：按时间把浅层记忆分批放掉，不删除，只设 valid_to。
   * - episodic 超过 maturingDays：importance 压到 2（只在被命中时出现）
   * - episodic 超过 retireDays：写 valid_to，退出注入与检索，记录保留可回溯
   * - working 超过 workingDays：写 valid_to（任务状态过期）
   * 纯 SQL，不调模型，可安全重复执行。
   */
  expireTide(args = {}) {
    const maturingDays = clampInt(args.maturingDays, 1, 3650, 30)
    const retireDays = clampInt(args.retireDays, 2, 3650, 30)
    const workingDays = clampInt(args.workingDays, 1, 3650, 7)
    const now = nowMs()
    const day = 86400000
    const retireBefore = now - retireDays * day
    const matureBefore = now - Math.min(maturingDays, retireDays - 1) * day
    const workingBefore = now - workingDays * day
    let retired = 0
    let matured = 0
    let working = 0
    try {
      const r = this.db.prepare(
        "UPDATE memories SET valid_to=?, updated_at=? WHERE layer='episodic' AND status='active' AND valid_to IS NULL AND created_at < ?"
      ).run(now, now, retireBefore)
      retired = Number(r?.changes ?? 0)
      const m = this.db.prepare(
        "UPDATE memories SET importance=2, updated_at=? WHERE layer='episodic' AND status='active' AND valid_to IS NULL AND created_at < ? AND importance > 2"
      ).run(now, matureBefore)
      matured = Number(m?.changes ?? 0)
      const w = this.db.prepare(
        "UPDATE memories SET valid_to=?, updated_at=? WHERE layer='working' AND status='active' AND valid_to IS NULL AND created_at < ?"
      ).run(now, now, workingBefore)
      working = Number(w?.changes ?? 0)
      // 硬约束：潮池只允许动 episodic（浅层）和 working（工作层）。
      // core（核心）、semantic（语义）以及 persona 表永不参与退潮；这里做断言兜底，
      // 哪天有人把上面的 SQL 改到别的层，这一步立刻返回失败并留事件。
      const guarded = this.db.prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE layer IN ('core','semantic') AND status='active' AND valid_to IS NOT NULL"
      ).get()
      if (Number(guarded?.n ?? 0) > 0) {
        try { this.event('tide.guard.violation', null, null, { n: Number(guarded.n) }) } catch { /* ignore */ }
        return { ok: false, error: 'protected layer touched', retired, matured, working }
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), retired, matured, working }
    }
    if (retired + matured + working > 0) {
      try { this.event('tide.tick', null, null, { retired, matured, working }) } catch { /* ignore */ }
      try { this.setMeta('last_tide_at', String(now)) } catch { /* ignore */ }
    }
    return { ok: true, retired, matured, working, total: retired + matured + working }
  }

  /** Counts used by the dashboard/admin tool. */
  stats() {
    const byLayer = {}
    for (const layer of LAYERS) {
      byLayer[layer] = this.db.prepare(
        "SELECT status, COUNT(*) AS n FROM memories WHERE layer=? GROUP BY status"
      ).all(layer).reduce((acc, x) => { acc[x.status] = x.n; return acc }, {})
    }
    const pending = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status='pending'").get().n
    const persona = this.db.prepare('SELECT COUNT(*) AS n FROM persona WHERE active=1').get().n
    const ret = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(est_tokens),0) AS tokens, COALESCE(SUM(items),0) AS items FROM retrieval_log').get()
    const recent = this.db.prepare('SELECT query,items,chars,est_tokens,at FROM retrieval_log ORDER BY id DESC LIMIT 5').all()
    let dbBytes = 0
    try { dbBytes = statSync(this.dbPath).size } catch (statError) { void statError }
    return {
      ok: true,
      dir: this.dir,
      dbPath: this.dbPath,
      dbBytes,
      byLayer,
      pending,
      persona,
      retrievals: ret.n,
      retrievalTokens: ret.tokens,
      retrievalItems: ret.items,
      recentRetrievals: recent,
      backups: this.listBackups().slice(-5)
    }
  }

  logRetrieval(query, items, chars, estTokens, source = 'context') {
    this.db.prepare('INSERT INTO retrieval_log(at,query,items,chars,est_tokens,source) VALUES(?,?,?,?,?,?)')
      .run(nowMs(), String(query).slice(0, 500), items, chars, estTokens, source)
  }

  listBackups() {
    try {
      return readdirSync(this.backupDir).filter((x) => x.endsWith('.db')).sort()
    } catch (readError) { void readError; return [] }
  }

  backup(reason = 'manual') {
    const name = 'memory-' + stamp(nowMs()) + '-' + (String(reason).replace(/[^a-z0-9-]/gi, '') || 'manual') + '.db'
    const target = join(this.backupDir, name)
    if (existsSync(target)) rmSync(target)
    this.db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'")
    this.setMeta('last_backup_at', String(nowMs()))
    this.event('backup.created', null, null, { file: name, reason })
    this.pruneBackups()
    return { file: target, name }
  }

  pruneBackups() {
    const files = this.listBackups()
    while (files.length > this.keepBackups) {
      const victim = files.shift()
      try { rmSync(join(this.backupDir, victim)) } catch (rmError) { void rmError }
    }
  }

  maybeDailyBackup() {
    const today = isoDay(nowMs())
    if (this.getMeta('last_backup_day') === today) return null
    const made = this.backup('daily')
    this.setMeta('last_backup_day', today)
    return made
  }

  /**
   * Restore a backup. Safety-backup first, then close -> copy -> reopen ->
   * integrity check. A failed check restores the safety copy.
   */
  restore(path) {
    const source = resolve(String(path ?? ''))
    if (!existsSync(source) || !statSync(source).isFile()) {
      return { ok: false, note: '备份文件不存在：' + source }
    }
    const check = new DatabaseSync(source, { readOnly: true })
    try {
      const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name)
      if (!tables.includes('memories') || !tables.includes('persona')) {
        return { ok: false, note: '目标文件不是本插件的记忆备份。' }
      }
      const integrity = check.prepare('PRAGMA integrity_check').get()
      if (integrity?.integrity_check !== 'ok') return { ok: false, note: '备份完整性检查失败。' }
    } finally { check.close() }

    const safety = this.backup('before-restore')
    const tmp = this.dbPath + '.restoring'
    copyFileSync(source, tmp)
    this.close()
    for (const suffix of ['-wal', '-shm']) {
      try { rmSync(this.dbPath + suffix) } catch (rmError) { void rmError }
    }
    renameSync(tmp, this.dbPath)
    this.open()
    try {
      const integrity = this.db.prepare('PRAGMA integrity_check').get()
      if (integrity?.integrity_check !== 'ok') throw new Error('integrity check failed after restore')
    } catch (error) {
      this.close()
      copyFileSync(safety.file, this.dbPath)
      this.open()
      return { ok: false, note: '恢复失败，已回滚到恢复前备份：' + String(error.message ?? error) }
    }
    this.event('backup.restored', null, null, { from: source })
    return { ok: true, restored: source, safety: safety.file, note: '已恢复。恢复前的数据保存在 safety 备份中。' }
  }

  /** Human-readable export (Markdown + JSON snapshot). */
  exportAll() {
    const all = this.db.prepare('SELECT * FROM memories ORDER BY layer, updated_at DESC').all().map(publicRow)
    const persona = this.readPersona(true)
    const at = stamp(nowMs())
    const lines = ['# 长期记忆导出', '', '生成时间：' + new Date(nowMs()).toISOString(), '', '## 人格设定（单独存储）', '']
    for (const p of persona.filter((x) => x.active)) lines.push('- **' + p.key + '**（v' + p.version + '）：' + p.content)
    for (const layer of LAYERS) {
      const rows = all.filter((x) => x.layer === layer)
      if (rows.length === 0) continue
      lines.push('', '## ' + layer + ' (' + rows.length + ')', '')
      for (const r of rows) {
        lines.push('- ' + r.id + ' [' + r.status + '/' + r.category + '] ' + r.content)
        lines.push('  - 更新：' + new Date(r.updatedAt).toISOString() + '；来源：' + r.source + '；重要度：' + r.importance)
        if (r.supersededBy) lines.push('  - 被取代：' + r.supersededBy)
      }
    }
    const md = join(this.exportDir, 'memory-export-' + at + '.md')
    writeFileSync(md, lines.join('\n') + '\n', 'utf8')
    const jsonPath = join(this.exportDir, 'memory-export-' + at + '.json')
    writeFileSync(jsonPath, JSON.stringify({ at: new Date(nowMs()).toISOString(), persona, memories: all }, null, 2) + '\n', 'utf8')
    return { markdown: md, json: jsonPath, count: all.length }
  }
}

function mergeTags(a, b) {
  return [...new Set([...(a ?? []), ...(b ?? [])].map(String))]
}

export function publicRow(r) {
  return {
    id: r.id,
    layer: r.layer,
    category: r.category,
    content: r.content,
    key: r.key ?? null,
    tags: json(r.tags, []),
    importance: r.importance,
    confidence: r.confidence,
    status: r.status,
    source: r.source,
    sourceSession: r.source_session ?? null,
    sourceRef: r.source_ref ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    validTo: r.valid_to ?? null,
    supersededBy: r.superseded_by ?? null,
    conflictWith: r.conflict_with ?? null
  }
}
export { safeLayer, clampInt, isoDay, stamp }
