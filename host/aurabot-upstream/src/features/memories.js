// 读主人的整个记忆库（DSH memory-layers），每天第一条消息 / 新会话时看一眼。
// 先试宿主自带的 node:sqlite；不支持就用系统 node 跑 mem-brief.mjs。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DB = 'E:\\DSH\\memory-layers\\memory.db'
const CONFIG = () => path.join(process.env.USERPROFILE || '', '.dsh', 'memory-layers', 'config.json')

function dbPath() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG(), 'utf8'))
    if (j && j.dir) return path.join(j.dir, 'memory.db')
  } catch (error) {}
  return DEFAULT_DB
}

let cache = { at: 0, text: '' }
const TTL = 10 * 60_000
const clean = (s) => String(s).replace(/\s+/g, ' ').trim()

async function readDirect() {
  const file = dbPath()
  if (!fs.existsSync(file)) return ''
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const parts = []
    const core = db.prepare("select content from memories where status='active' and layer='core' order by importance desc, updated_at desc").all()
    if (core.length) { parts.push('【一直记得的】'); for (const r of core) parts.push('- ' + clean(r.content).slice(0, 200)) }
    const persona = db.prepare("select key, content from persona where active=1").all()
    if (persona.length) { parts.push('【人格层】'); for (const p of persona) parts.push('- ' + clean(p.content).slice(0, 200)) }
    const sem = db.prepare("select content from memories where status='active' and layer='semantic' order by importance desc, updated_at desc limit 40").all()
    if (sem.length) { parts.push('【知道的事】'); for (const r of sem) parts.push('- ' + clean(r.content).slice(0, 140)) }
    const epi = db.prepare("select content from memories where status='active' and layer='episodic' order by created_at desc limit 60").all()
    if (epi.length) { parts.push('【这几天发生的】'); for (const r of epi) parts.push('- ' + clean(r.content).slice(0, 140)) }
    const work = db.prepare("select content from memories where status='active' and layer='working' order by updated_at desc limit 10").all()
    if (work.length) { parts.push('【手上正做的】'); for (const r of work) parts.push('- ' + clean(r.content).slice(0, 120)) }
    return parts.join('\n')
  } finally {
    try { db.close() } catch (error) {}
  }
}

async function readByChild() {
  const { stdout } = await run('node', [path.join(HERE, 'mem-brief.mjs')], { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  const j = JSON.parse(String(stdout || '{}'))
  return String(j.brief || '')
}

/** 整个记忆库压成一段话；没有就返回空串。 */
export async function memoryBrief() {
  if (cache.text && Date.now() - cache.at < TTL) return cache.text
  for (const read of [readDirect, readByChild]) {
    try {
      const text = await read()
      if (text) { cache = { at: Date.now(), text }; return text.slice(0, 6000) }
    } catch (error) {}
  }
  return ''
}

/** 每天开始时递给她看的那段。 */
export async function memoryOpening() {
  const brief = await memoryBrief()
  if (!brief) return ''
  return '【今天的记忆：这是你自己记下来的东西】\n' + brief
    + '\n（不用念出来，自然带着就行。今天遇到的小事也要记下来，晚上写进浅层记忆。）'
}
