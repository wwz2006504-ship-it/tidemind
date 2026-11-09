
/**
 * Zero-LLM automatic capture.
 *
 * The point is not to extract everything. It is to notice the few sentences
 * whose grammar itself signals long-term value (identity, preference, rule,
 * commitment, event, task) and put them into the right layer. Anything vague
 * lands in the pending queue instead of becoming a fact.
 */
const SECRET = /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:api[_-]?key|password|passwd|secret|token)\s*[:=：]|密码\s*(?:是|为|[:=：])|身份证号|银行卡号|信用卡号|验证码\s*[:=：]?)/i
const LONG_HEX = /[a-f0-9]{32,}/i

function splitSentences(text) {
  return String(text ?? '')
    .split(/[。！？!?\n；;]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4 && x.length <= 260)
}

const RULES = [
  {
    id: 'identity', layer: 'core', category: 'identity', confidence: 0.9,
    re: /(?:我(?:的名字)?叫|我的名字是|我是|我的生日是|我住在|我家在)/
  },
  {
    id: 'preference', layer: 'semantic', category: 'preference', confidence: 0.82,
    re: /我(?:很|最|特别|比较|一直)?(?:喜欢|爱|讨厌|不喜欢|习惯|偏爱|受不了|迷上)/
  },
  {
    id: 'relationship', layer: 'core', category: 'relationship', confidence: 0.82,
    re: /我(?:的)?(?:爸爸|妈妈|父亲|母亲|女儿|儿子|老婆|老公|家人|朋友|男朋友|女朋友|哥哥|姐姐|弟弟|妹妹)/
  },
  {
    id: 'rule', layer: 'core', category: 'rule', confidence: 0.85,
    re: /(?:以后|今后|从现在起|下次)(?:都|要|别|不要|必须|记得)|我们(?:约定|说好)|答应我|你要记得/
  },
  {
    id: 'goal', layer: 'core', category: 'goal', confidence: 0.78,
    re: /我的(?:目标|计划|打算|愿望|梦想)是|我(?:计划|打算|准备)(?:要|去|做)/
  },
  {
    id: 'working', layer: 'working', category: 'task', confidence: 0.72,
    re: /(?:现在|目前|正在|下一步|已经完成|还没完成|进度是|当前任务)/
  },
  {
    id: 'event', layer: 'episodic', category: 'event', confidence: 0.68,
    re: /(?:今天|昨天|前天|刚才|刚刚|上周|上个星期|去年|\d{1,2}\s*月\s*\d{1,2}\s*[日号]).*(?:发生|决定|完成|去了|买了|见了|做了|开始|结束|搬|换|修|装|弄|搞|改|升级|部署|上线|写完|做好)/
  },
  {
    id: 'explicit', layer: 'semantic', category: 'fact', confidence: 0.9,
    re: /(?:记住|记一下|别忘了|帮我记住|要记得)/
  }
]

function cleanSentence(s) {
  return s
    .replace(/^(?:请|麻烦)?(?:你)?(?:一定要|千万)?(?:记住|记一下|帮我记住|别忘了|要记得)[，,:：\s]*/, '')
    .trim()
}

function containsSecret(text) {
  return SECRET.test(text) || LONG_HEX.test(text)
}

/** Pick at most three high-signal sentences. */
export function extractCandidates(text) {
  const out = []
  const seen = new Set()
  for (const sentence of splitSentences(text)) {
    if (containsSecret(sentence)) continue
    for (const rule of RULES) {
      if (!rule.re.test(sentence)) continue
      const content = cleanSentence(sentence)
      if (content.length < 4) continue
      const normalized = content.replace(/\s+/g, '')
      if (seen.has(normalized)) break
      seen.add(normalized)
      const entry = {
        layer: rule.layer,
        category: rule.category,
        content,
        confidence: rule.confidence,
        rule: rule.id
      }
      // A explicit memorization verb plus a preference stays a preference.
      if (rule.id === 'explicit') {
        const pref = RULES.find((r) => r.id === 'preference')
        if (pref.re.test(content)) {
          entry.layer = pref.layer
          entry.category = pref.category
          entry.confidence = Math.max(entry.confidence, pref.confidence)
        }
      }
      if (rule.id === 'working') entry.key = 'current-task'
      out.push(entry)
      break
    }
    if (out.length >= 3) break
  }
  return out
}

/** Store extracted candidates. Returns a compact result list for logs/tests. */
export async function captureText(store, config, text, meta = {}) {
  const results = []
  for (const candidate of extractCandidates(text)) {
    const status = candidate.confidence >= (Number(config.autoCaptureMinConfidence) || 0.75)
      ? 'active'
      : 'pending'
    const result = await store.write({
      ...candidate,
      status,
      source: 'auto',
      importance: candidate.layer === 'core' ? 4 : candidate.layer === 'working' ? 3 : 3,
      source_session: meta.sessionId ?? null,
      source_turn: meta.turn ?? null,
      source_ref: meta.excerpt ? String(meta.excerpt).slice(0, 200) : null
    })
    results.push({ rule: candidate.rule, layer: candidate.layer, category: candidate.category, content: candidate.content, ...result })
  }
  return results
}
