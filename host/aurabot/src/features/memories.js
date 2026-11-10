// 读主人的整个记忆库（DSH memory-layers），每天第一条消息 / 新会话时看一眼。
// 先试宿主自带的 node:sqlite；不支持就用系统 node 跑 mem-brief.mjs。

import fs from 'node:fs'
import path from 'node:path'
import {allowedAgent} from '../../../../integration/fenced-store.mjs'
import {checkedPath} from '../../../../TideMind/deploy/existing/tide-replica.mjs'

function dbPath() {
  const file=process.env.TIDEMIND_AURABOT_MEMORY_DB
  if(!file)throw new Error('explicit isolated memory database required')
  return checkedPath(file)
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
    const core = db.prepare("select content from memories where status='active' and valid_to IS NULL and layer='core' order by importance desc, updated_at desc").all()
    if (core.length) { parts.push('【一直记得的】'); for (const r of core) parts.push('- ' + clean(r.content).slice(0, 200)) }
    const persona = db.prepare("select key, content from persona where active=1").all()
    if (persona.length) { parts.push('【人格层】'); for (const p of persona) parts.push('- ' + clean(p.content).slice(0, 200)) }
    const sem = db.prepare("select content from memories where status='active' and valid_to IS NULL and layer='semantic' order by importance desc, updated_at desc limit 40").all()
    if (sem.length) { parts.push('【知道的事】'); for (const r of sem) parts.push('- ' + clean(r.content).slice(0, 140)) }
    const epi = db.prepare("select content from memories where status='active' and valid_to IS NULL and layer='episodic' order by created_at desc limit 60").all()
    if (epi.length) { parts.push('【这几天发生的】'); for (const r of epi) parts.push('- ' + clean(r.content).slice(0, 140)) }
    const work = db.prepare("select content from memories where status='active' and valid_to IS NULL and layer='working' order by updated_at desc limit 10").all()
    if (work.length) { parts.push('【手上正做的】'); for (const r of work) parts.push('- ' + clean(r.content).slice(0, 120)) }
    return parts.join('\n')
  } finally {
    try { db.close() } catch (error) {}
  }
}

// No child-process fallback or production config lookup is allowed in this isolated copy.
export async function memoryBrief(agent) {
  if(!allowedAgent(agent))return ''
  try {
    const file=dbPath()
    if(cache.file===file && cache.text && Date.now()-cache.at<TTL)return cache.text
    const text=await readDirect()
    cache={file,at:Date.now(),text:text.slice(0,6000)}
    return cache.text
  }catch{return ''}
}

/** 每天开始时递给她看的那段。 */
export async function memoryOpening(agent) {
  const brief = await memoryBrief(agent)
  if (!brief) return ''
  return '【今天的记忆：这是你自己记下来的东西】\n' + brief
    + '\n（不用念出来，自然带着就行。今天遇到的小事也要记下来，晚上写进浅层记忆。）'
}
