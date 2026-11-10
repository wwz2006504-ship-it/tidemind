/**
 * Default heartbeat prompt and the settings-namespace identity.
 *
 * The prompt is delivered to the agent as a synthetic user-role message
 * (source kind `plugin`), so the client renders it as a collapsed context
 * chip instead of a full user bubble. Keep it dense: it is both the model
 * instruction and the visible transcript artifact.
 *
 * @module dsh-plugin-heartbeat/prompt
 */

export const SETTINGS_NAMESPACE = 'heartbeat'

export const DEFAULT_PROMPT = [
  '【心跳】由 heartbeat 插件定时唤醒，不是用户的消息。当前时间 {{time}}。',
  '轻量唤醒模式：不要调用任何工具，不要复盘全部历史，只基于最近对话快速判断。',
  '快速判断后选一种回应：',
  '1. 有实质进展、风险、卡点或新发现 → 简明汇报，先结论后细节；',
  '2. 有悬而未决、需要阿周拍板的 → 直接提问；',
  '3. 都没什么 → 回一句简短的日常状态即可。',
  '要求：总长 ≤5 句，中文，小蓝口吻（外松内紧）；不主动开始新任务，不重复车轱辘话。',
].join('\n')


/**
 * 续醒提示词：主拍送达后，在 awakeSeconds 窗口内每隔 awakeBeatSeconds 再叫一次，
 * 让她多待一会儿，而不是一句话就睡回去。不增加 missedCount、不触发退避与硬停。
 * 这次允许用工具——醒着的意义是能真的做点事，不是再交一句话。
 */
export const DEFAULT_STAY_PROMPT = [
  '【续醒】心跳刚叫过你一次，你还醒着（{{time}}）。',
  '这不是新的汇报要求：手上真有事就接着做，可以用工具，做完不用汇报；',
  '没事就把这几十秒当成待着，回一句很短的日常就行，也可以什么都不说。',
].join('\n')

/**
 * Substitute supported placeholders in a prompt template.
 * @param {string} template
 * @param {Date} [now]
 * @returns {string}
 */
export function renderPrompt(template, now = new Date()) {
  return template.replaceAll('{{time}}', now.toLocaleString('zh-CN', { hour12: false }))
}
