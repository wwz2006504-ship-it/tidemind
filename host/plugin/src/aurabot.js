import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { estimateTokens } from './store.js'

// Read through the existing UI store; never write or consolidate its data.
export function aurabotContext(query, budget = 180, file = process.env.TIDEMIND_AURABOT_FIXTURE) {
  if (!file) return { lines: [], tokens: 0, items: 0 }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const q = String(query).toLowerCase()
    const lines = []
    let tokens = 0
    const add = (text) => {
      const line = '- ' + String(text).replace(/\s+/g, ' ').trim()
      const cost = estimateTokens(line + '\n')
      if (line.length > 2 && tokens + cost <= budget) { lines.push(line); tokens += cost }
    }
    const keys = new Set([...Object.keys(data.insights || {}), ...Object.keys(data.styles || {})])
    for (const key of keys) {
      if (key === 'self') continue
      const id = key.replace(/^qq:/, '')
      const name = data.insightNames?.[key]
      // Never mix several people's records merely because their habits overlap.
      if (!(id.length >= 5 && q.includes(id)) && !(typeof name === 'string' && name.length >= 2 && q.includes(name.toLowerCase()))) continue
      const label = name || id
      const profile = data.profiles?.[id]
      if (profile && typeof profile === 'object') {
        for (const [field, value] of Object.entries(profile)) {
          if (typeof value === 'string' && !/name|id|at|time/i.test(field)) add(label + '：' + value)
        }
      }
      for (const text of data.insights?.[key] || []) if (typeof text === 'string') add(label + '相处经验：' + text)
      if (/说话|语气|风格|口吻/.test(q)) for (const text of data.styles?.[key] || []) if (typeof text === 'string') add(label + '说话方式：' + text)
    }
    if (/你.*(说话|语气|风格|口吻)|自己.*(说话|风格)/.test(q)) {
      for (const text of data.styles?.self || []) if (typeof text === 'string') add('角色自身风格：' + text)
    }
    return { lines, tokens, items: lines.length }
  } catch { return { lines: [], tokens: 0, items: 0 } }
}
