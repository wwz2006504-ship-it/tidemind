// 读整个记忆库：核心 + 语义 + 浅层 + 工作状态 + 人格层，压成一段话。
// 被 memories.js 用系统 node 调起来跑（宿主那个 node 未必带 node:sqlite）。
import fs from 'node:fs'
import path from 'node:path'

const cfg = path.join(process.env.USERPROFILE || '', '.dsh', 'memory-layers', 'config.json')
let dir = 'E:\\DSH\\memory-layers'
try { const j = JSON.parse(fs.readFileSync(cfg, 'utf8')); if (j && j.dir) dir = j.dir } catch (error) {}
const file = path.join(dir, 'memory.db')

function emit(brief, count) { process.stdout.write(JSON.stringify({ brief, count })) }

if (!fs.existsSync(file)) { emit('', 0); process.exit(0) }
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(file, { readOnly: true })
const clean = (s) => String(s).replace(/\s+/g, ' ').trim()
const parts = []
let n = 0

const core = db.prepare("select content from memories where status='active' and layer='core' order by importance desc, updated_at desc").all()
if (core.length) { parts.push('【一直记得的】'); for (const r of core) { parts.push('- ' + clean(r.content).slice(0, 200)); n++ } }

const persona = db.prepare("select key, content from persona where active=1").all()
if (persona.length) { parts.push('【人格层】'); for (const p of persona) { parts.push('- ' + clean(p.content).slice(0, 200)); n++ } }

const sem = db.prepare("select content from memories where status='active' and layer='semantic' order by importance desc, updated_at desc limit 40").all()
if (sem.length) { parts.push('【知道的事】'); for (const r of sem) { parts.push('- ' + clean(r.content).slice(0, 140)); n++ } }

const epi = db.prepare("select content from memories where status='active' and layer='episodic' order by created_at desc limit 60").all()
if (epi.length) { parts.push('【这几天发生的】'); for (const r of epi) { parts.push('- ' + clean(r.content).slice(0, 140)); n++ } }

const work = db.prepare("select content from memories where status='active' and layer='working' order by updated_at desc limit 10").all()
if (work.length) { parts.push('【手上正做的】'); for (const r of work) { parts.push('- ' + clean(r.content).slice(0, 120)); n++ } }

db.close()
emit(parts.join('\n'), n)
