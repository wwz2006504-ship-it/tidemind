// 本机视觉模型（Ollama + qwen2.5vl）：把一张截图变成一段中文描述。
// 主模型是纯文本的时候，用这条路替她"看"。

const ENDPOINT = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat'
const MODEL = process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:7b'

/** 本机视觉能不能用（服务在不在、模型有没有）。 */
export async function visionReady() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return false
    const j = await res.json()
    return (j.models || []).some((m) => String(m.name || '').includes('vl'))
  } catch (error) {
    return false
  }
}

/**
 * 看一张图，返回一段中文描述。
 * @param {string} base64 图片 base64（不带 data: 前缀也可以）
 * @param {string} prompt 想让它看什么
 * @param {{timeoutMs?:number, numPredict?:number}} [opts]
 * @returns {Promise<string>}
 */
export async function describeImage(base64, prompt, opts = {}) {
  const clean = String(base64 || '').replace(/^data:[^,]+,/, '')
  if (!clean) throw new Error('没有图片数据')
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(opts.timeoutMs || 60000),
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { temperature: 0.2, num_predict: opts.numPredict || 260 },
      messages: [{
        role: 'user',
        content: String(prompt || '用两三句中文描述这张图里在做什么，有没有报错或弹窗。不要念出密码、聊天内容这类隐私。'),
        images: [clean],
      }],
    }),
  })
  if (!res.ok) throw new Error('视觉服务返回 ' + res.status + '：' + (await res.text()).slice(0, 160))
  const j = await res.json()
  const text = String(j?.message?.content || '').trim()
  if (!text) throw new Error('视觉模型没有输出')
  return text.slice(0, 600)
}
