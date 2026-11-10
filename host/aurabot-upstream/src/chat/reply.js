import { appendFileSync, mkdirSync } from 'node:fs'

// 把模型的一轮回复拆成要发到 QQ 的「一条条消息」。
//
// 模型输出约定（写在人格卡里）：
//   - `|||` 分隔多条气泡
//   - `<voice>…</voice>` 包住的内容发成语音
//   - `<sticker:标签>` 发一张表情（可写 `<sticker:标签></sticker>`）
//   - `<poke>` = 戳一戳对方
//   - `<reply:编号>` 写在某句前面 = 这句以「引用回复」发出（群聊里引用提示词中带编号的那条消息）
//   - 整轮只输出 `[沉默]`（或空）= 这次不说话（群聊插话用）
// 另外顺手把模型偶尔漏出来的 Markdown 洗掉——QQ 不渲染 Markdown。

export const SILENCE = '[沉默]'

/** 去掉 Markdown 痕迹，保留文字本身。 */
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 是不是「这次不说话」。 */
export function isSilence(text) {
  const t = String(text || '').trim()
  return t === '' || t === SILENCE || t === '［沉默］' || t === '(沉默)' || t === '（沉默）'
}

/**
 * 清掉模型偶尔漏出来的分隔标记。
 * 见过不止一次：「……三条内。end 好。 好。END 试了也没用……」，END / end 会当正文发到 QQ 上。
 * 只清单独成词的 END / end（连同紧跟的标点），不动 weekend 这种词。
 */
export function stripLeakedMarkers(text) {
  return String(text || '')
    .replace(/<\/?end>/gi, '')
    .replace(/\[\/?(?:end|END)\]/g, '')
    // 2026-10-31：模型开始把工具调用标记漏进正文——「去，这就说 </｜｜DSML｜｜ parameter>
    // </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>」。整段、半截、孤立片段都不该到 QQ 上。
    .replace(/(?:<\/?)?[|｜]{1,2}\s*DSML\s*[|｜][^>\n]*>/gi, '')
    .replace(/(?:<\/?)?[|｜]{2}\s*DSML\s*[|｜]{1,2}[^\n]*/gi, '')
    .replace(/(?<![A-Za-z])(?:END|end)(?![A-Za-z])[.。]?[ \t]*/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

/**
 * 清掉模型漏出来的「自言自语」。
 * 现象（2026-10-30 晚上，21 点后 20 条）：她先写一句给自己的盘算——
 * 「回 3 行。」「收尾。 3 行。」「直接问：你看到的那条原文是啥。」——再接正文，
 * 整段被当成气泡发到 QQ。
 * 规则：① 出现「回」「回：」「回。」这种交接标记，就以最后一个标记为界，只留后面的正文；
 *      ② 没有标记时，掐掉开头那句很短的「计划」（以句号结尾、含 行/语气/收尾/诚实/直接问 之类）。
 */
const XINLIHUA_DIR = 'C:\\Users\\USERNAME\\WORKSPACE\\NOTES'

/** 把切下来的话落到「心里话」当天文件里——这些话不该发出去，但也不该丢。 */
function saveSelfNotes(notes, label = '盘算') {
  const list = notes.map((n) => String(n).trim().replace(/\s+/g, ' ')).filter((n) => n.length > 1)
  if (!list.length) return
  try {
    mkdirSync(XINLIHUA_DIR, { recursive: true })
    const d = new Date()
    const pad = (v) => String(v).padStart(2, '0')
    const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes())
    const body = list.map((n) => '- ' + hm + ' · ' + label + '：' + n).join('\n')
    appendFileSync(XINLIHUA_DIR + '\\' + day + '.md', body + '\n', 'utf8')
  } catch {
    // 写不进去也不能影响发消息
  }
}

/**
 * 她自己写给自己的话：<内心>…</内心>。
 * 2026-11-01 主人说，这种「我在干什么、我在等什么」的自言自语老是直接发到他 QQ 上，
 * 该落到心里话文件夹里。所以标签里的内容截下来存盘，标签外的才是要发出去的话。
 * 没闭合的 <内心> 一路吃到结尾——宁可这一轮少说一句，也别把他的聊天框当日记本。
 */
export function extractInnerNotes(text) {
  const notes = []
  let s = String(text || '')
  s = s.replace(/<内心>([\s\S]*?)<\/内心>/g, (_, body) => { notes.push(body); return ' ' })
  s = s.replace(/<内心>([\s\S]*)$/g, (_, body) => { notes.push(body); return ' ' })
  if (notes.length) saveSelfNotes(notes, '自言自语')
  return s
}

export function stripSelfNotes(text) {
  const removed = []
  let s = String(text || '')
  const marks = [...s.matchAll(/(?:^|[\s。！？…~])回[：:。]?\s*(?:\d+\s*行[。.]\s*)?/g)]
  if (marks.length) {
    const last = marks[marks.length - 1]
    const cut = (last.index ?? 0) + last[0].length
    const keep = s.slice(cut)
    if (keep.trim()) {
      removed.push(s.slice(0, cut))
      s = keep
    }
  }
  s = s.replace(/(?:^|[\s。！？…~])\d+\s*行[。.]\s*/g, (m) => { removed.push(m); return ' ' })
  s = s.replace(/(?:^|[\s。！？…~])[^\s。]{0,4}?(?:语气|收尾|盘算|诚实|直接问|先问|回应他|回应她)[^。\n]{0,6}?[。.]\s*/g, (m) => { removed.push(m); return ' ' })
  const out = s.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+/gm, '').trim()
  if (removed.length) saveSelfNotes(removed)
  return out
}

/**
 * 解析一轮回复。
 * @param {string} text 模型这一轮的最终正文
 * @returns {{silent: boolean, items: Array<{kind:'text'|'voice'|'sticker'|'image', value:string, replyTo?:string}>}}
 */
export function parseReply(text) {
  const raw = extractInnerNotes(stripLeakedMarkers(String(text || '').trim())).trim()
  if (isSilence(raw)) return { silent: true, items: [] }
  const items = []
  let replyTo = '' // 等着挂到下一条气泡上的「引用回复」编号
  const attach = (from) => {
    if (replyTo && items.length > from) {
      items[from].replyTo = replyTo
      replyTo = ''
    }
  }
  for (const bubble of raw.split('|||')) {
    const part = stripSelfNotes(bubble.trim())
    if (!part) continue
    // 依次切出 reply / voice / sticker / markdown 图片，其余是文字
    const re = /<poke\s*\/?>|<reply:\s*(\d+)\s*>|<voice>([\s\S]*?)<\/voice>|<sticker:([^>]+?)>(?:\s*<\/sticker>)?|!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g
    let last = 0
    let m
    while ((m = re.exec(part)) !== null) {
      let from = items.length
      pushText(items, part.slice(last, m.index))
      attach(from)
      from = items.length
      if (m[0].startsWith('<poke')) {
        if (!items.some((i) => i.kind === 'poke')) items.push({ kind: 'poke', value: '' })
      } else if (m[1] !== undefined) {
        replyTo = m[1]
      } else if (m[2] !== undefined) {
        const v = stripMarkdown(m[2])
        if (v) items.push({ kind: 'voice', value: v })
      } else if (m[3] !== undefined) {
        const v = m[3].trim()
        if (v) items.push({ kind: 'sticker', value: v })
      } else if (m[4] !== undefined) {
        items.push({ kind: 'image', value: m[4] })
      }
      attach(from)
      last = re.lastIndex
    }
    const from = items.length
    pushText(items, part.slice(last))
    attach(from)
  }
  // 一轮最多引用一次，多的去掉（大多数时候正常发就好）
  let quoted = false
  for (const it of items) {
    if (!it.replyTo) continue
    if (quoted) delete it.replyTo
    quoted = true
  }
  if (items.length === 0) return { silent: true, items: [] }
  return { silent: false, items: capBubbles(items) }
}

const MAX_BUBBLES = 5

/** 文字气泡最多 5 条，多出来的并进最后一条（防止刷屏）。 */
function capBubbles(items) {
  const texts = items.filter((i) => i.kind === 'text')
  if (texts.length <= MAX_BUBBLES) return items
  const keep = new Set(texts.slice(0, MAX_BUBBLES - 1))
  const tail = texts.slice(MAX_BUBBLES - 1)
  const merged = { kind: 'text', value: tail.map((t) => t.value).join('\n') }
  const out = []
  let placed = false
  for (const it of items) {
    if (it.kind !== 'text' || keep.has(it)) out.push(it)
    else if (!placed) { out.push(merged); placed = true }
  }
  return out
}

/**
 * 一段文字拆成几条气泡：真人打字是一行一条发出去的。
 * 有代码块、或者是长篇内容（比如帮主人查东西的结果）就整段发，不拆。
 */
export function splitLines(text) {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.includes('```') || t.length > 240) return [t]
  const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  if (lines.length <= 1) return lines
  // 像列表 / 步骤的多行内容（一大半以数字或符号开头）也整段发
  const listy = lines.filter((l) => /^(\d+[.、)]|[-*•·])/.test(l)).length
  if (listy >= Math.ceil(lines.length / 2)) return [t]
  return lines
}

function pushText(items, s) {
  const t = stripMarkdown(String(s || '').replace(/<\/?reply[^>]*>/g, '')) // 写坏的引用标签直接去掉
  if (!t || isSilence(t)) return
  for (const line of splitLines(t)) if (!isSilence(line)) items.push({ kind: 'text', value: line })
}

/** 对方是不是明确要她发语音（「用语音说」「发个语音」「语音回我」……）。 */
export function wantsVoice(text) {
  const t = String(text || '')
  if (t.includes('不要语音') || t.includes('别发语音')) return false
  return /(用|发|来|给我|录)[^，。？！\n]{0,4}语音|语音[^，。？！\n]{0,4}(说|发|讲|回|念|唱)/.test(t)
}

/**
 * 发下一条之前停多久（毫秒）：按「打字速度」算——下一条越长停越久，再加一点随机抖动。
 * @param {string} [next] 下一条要发的内容
 */
export function bubbleDelay(next = '', rand = Math.random) {
  if (typeof next === 'function') { rand = next; next = '' }
  const len = String(next || '').length
  const typing = 350 + len * 110 // 大约每秒 9 个字
  return Math.round(Math.min(4500, Math.max(700, typing)) * (0.8 + rand() * 0.5))
}
