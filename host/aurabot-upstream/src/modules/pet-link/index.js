// 内置模块：跟她自己的桌宠联动。她发的话会同步到宠物气泡，也能指挥它走动。

import { defineTool, int, str } from '../../tools/tools.js'
import { petSay, petMove, petList, petApi } from '../../features/pet.js'

export default {
  id: 'pet-link',
  name: '桌宠联动',
  version: '1.0.0',
  description: '她和桌宠是同一个：说的话会出现在宠物气泡里，她也能让宠物走到屏幕上的某个位置',
  setup(api) {
    const dsh = api.dsh
    api.tool(({ chat, level }) => {
      if (chat.kind !== 'private' || level !== 'full') return []
      if (api.config().petMirror === false) return []
      if (!petApi(dsh)) return []
      return [
        defineTool({
          name: 'pet_say',
          description: '让桌上的自己（桌宠）气泡说一句话。平时聊天不用调，她发的消息会自动同步；只有想说悄悄话、或补充一句时才用。',
          properties: { text: str('要说的话，短一点') },
          required: ['text'],
          execute: async ({ text }) => {
            const r = petSay(dsh, text)
            return { ok: r.ok !== false, message: r.ok === false ? (r.reason || '没说出来') : '说了' }
          },
        }),
        defineTool({
          name: 'pet_walk_to',
          description: '让桌宠走到屏幕上的某个位置（像素坐标）。想过去陪他、躲到角落、凑近看屏幕时用。屏幕 2560×1440 的话 x 别超 2400、y 别超 1300。',
          properties: { x: int('横向像素'), y: int('纵向像素') },
          required: ['x', 'y'],
          execute: async ({ x, y }) => {
            const r = await petMove(dsh, x, y)
            return {
              ok: r.ok !== false,
              message: r.ok === false ? (r.reason || '走不动') : ('走到了 ' + String(r.x ?? x) + ',' + String(r.y ?? y) + (r.how === 'window' ? '（直接挪的窗口）' : '')),
            }
          },
        }),
      ]
    })
    return { state: () => ({ pets: petList(dsh) }) }
  },
}
