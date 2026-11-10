// 内置模块：人格自改。让她能读、能改自己的人格卡（包括主人写的部分）。
// 每次改动都备份 + 记录，改坏了能退回去。

import fs from 'node:fs'
import path from 'node:path'
import { defineTool, str } from '../../tools/tools.js'
import { readPersona, savePersona } from '../../persona/personas.js'
import { dataDir } from '../../core/store.js'

const MAX_BODY = 40_000

export default {
  id: 'persona-self',
  name: '人格自改',
  version: '1.0.0',
  description: '她可以读、改自己的人格卡；改动会备份并记进 persona-evolution.jsonl',
  setup(api) {
    const cfgOf = () => api.config()
    const idNow = () => cfgOf().persona?.current || 'default'
    const limit = () => Number(cfgOf().persona?.selfEditPerDay ?? 10)

    function stateFile() {
      const f = path.join(dataDir(), 'persona-self-edit.json')
      try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (error) { return { day: '', n: 0 } }
    }
    function bump() {
      const s = stateFile()
      const today = new Date().toDateString()
      if (s.day !== today) { s.day = today; s.n = 0 }
      s.n += 1
      fs.writeFileSync(path.join(dataDir(), 'persona-self-edit.json'), JSON.stringify(s), 'utf8')
      return s.n
    }
    function canEdit() {
      const s = stateFile()
      const today = new Date().toDateString()
      const n = s.day === today ? s.n : 0
      return { ok: n < limit(), used: n, limit: limit() }
    }

    function backup(body) {
      const dir = path.join(dataDir(), 'persona-backups')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const f = path.join(dir, idNow() + '-' + stamp + '.md')
      fs.writeFileSync(f, body, 'utf8')
      return f
    }

    function logEdit(op, before, after) {
      const line = JSON.stringify({ at: Date.now(), op, before: before.slice(0, 400), after: after.slice(0, 400) })
      fs.appendFileSync(path.join(dataDir(), 'persona-evolution.jsonl'), line + '\n')
    }

    api.tool(({ chat, level }) => {
      if (chat.kind !== 'private' || level !== 'full') return []
      if (cfgOf().persona?.selfEdit === false) return []
      return [
        defineTool({
          name: 'persona_read',
          description: '读一遍你现在用的人格卡（就是你自己的设定）。想改自己之前先看看。',
          properties: {},
          execute: async () => {
            const p = readPersona(idNow())
            return { ok: true, message: p ? String(p.body).slice(0, 6000) : '没有人格卡' }
          },
        }),
        defineTool({
          name: 'persona_edit',
          description: '改你自己的人格卡。给 old_text 就把它替换成 new_text；old_text 留空就是追加到末尾。改之前会自动备份，能退回。',
          properties: {
            old_text: str('要替换的原句（必须和人格卡里一模一样；留空=追加）'),
            new_text: str('换成什么 / 追加什么'),
          },
          required: ['new_text'],
          execute: async ({ old_text, new_text }) => {
            const gate = canEdit()
            if (!gate.ok) return { ok: false, message: '今天已经改了 ' + gate.used + ' 次，明天再来（上限 ' + gate.limit + '）' }
            const p = readPersona(idNow())
            if (!p) return { ok: false, message: '没有人格卡' }
            const before = String(p.body || '')
            let after
            if (old_text && String(old_text).trim()) {
              const old = String(old_text)
              if (!before.includes(old)) return { ok: false, message: '人格卡里找不到这句，先 persona_read 看一眼原文' }
              after = before.replace(old, String(new_text))
            } else {
              after = before.replace(/\s+$/, '') + '\n\n' + String(new_text).trim() + '\n'
            }
            if (after.length > MAX_BODY) return { ok: false, message: '人格卡太长了（超过 ' + MAX_BODY + ' 字），先删点旧的' }
            backup(before)
            await savePersona(idNow(), { name: p.name, tags: p.tags || [], body: after })
            logEdit(old_text ? 'replace' : 'append', before.slice(-300), after.slice(-300))
            const n = bump()
            return { ok: true, message: '改好了（今天第 ' + n + ' 次），旧版本已备份' }
          },
        }),
      ]
    })

    return { state: () => ({ editsToday: stateFile() }) }
  },
}
