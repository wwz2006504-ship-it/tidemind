// 内置模块：主动搭话。主人一阵子没找她时，她会在私聊里主动找主人聊几句（群里不会）。

import { createSpeakUp } from '../../features/companion.js'
import { defineTool, str, int } from '../../tools/tools.js'

export default {
  id: 'speakup',
  name: '主动搭话',
  version: '1.1.0',
  description: '主人一阵子没理她时，在私聊里主动找主人说话；她也能给自己约时间，到点回来把想做的事做完',
  tab: 'speakup',
  files: ['features/companion.js'],
  setup(api) {
    const { hub, mutes } = api.core
    const speakUp = createSpeakUp({ getConfig: api.config, hub, log: api.log, isMuted: (chatId) => mutes.muted(chatId), dsh: api.dsh })
    api.every(60_000, () => speakUp.tick(), '主动搭话')
    api.route('/speakup/fire', async () => {
      if (!api.config().enabled) return { ok: false, message: '先打开总开关' }
      await speakUp.fire('手动')
      return { ok: true, message: '叫她去找你了' }
    })
    // 自己约时间：说了「我十分钟后去弄」就用它，到点真的叫她一轮
    api.tool(({ chat, level }) => {
      if (level !== 'full' || chat.kind !== 'private') return []
      const owner = api.config().ownerName || '主人'
      return [defineTool({
        name: 'qq_later',
        description: '给自己约个时间，过一会儿回来做/来说。说了「我待会儿去弄」「十分钟后再说」时用它；到点会真的叫你一轮，那时候直接动手，别再等' + owner + '发话。',
        properties: {
          minutes: int('几分钟后，1~720，默认 10'),
          what: str('到点要做的事，一句话'),
        },
        required: ['what'],
        execute: async ({ minutes, what }) => {
          const w = speakUp.wake(Number(minutes) || 10, what)
          const d = new Date(w.at)
          const hh = String(d.getHours()).padStart(2, '0')
          const mm = String(d.getMinutes()).padStart(2, '0')
          return { ok: true, message: '约好了，' + hh + ':' + mm + ' 叫你：' + w.what }
        },
      })]
    })
    return speakUp
  },
}
