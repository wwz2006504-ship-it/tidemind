// 内置模块：手机。她有一台安卓模拟器，用 adb 操作，可以刷抖音、看 B站。
// 原则：不常驻——要看才开机，玩完自己关；主人打游戏时一律关机。

import fs from 'node:fs'
import { defineTool, str, int } from '../../tools/tools.js'
import { phoneRunning, phoneOn, phoneOff, phoneLook, phoneTap, phoneSwipe, phoneType, phoneKey, phoneLaunch, gameRunning } from '../../features/phone.js'
import { describeImage } from '../../features/vision.js'

const APPS = {
  抖音: 'com.ss.android.ugc.aweme',
  douyin: 'com.ss.android.ugc.aweme',
  b站: 'com.bilibili.app.in',
  哔哩哔哩: 'com.bilibili.app.in',
  bilibili: 'com.bilibili.app.in',
}

export default {
  id: 'phone',
  name: '手机',
  version: '1.0.0',
  description: '她可以开机、看屏幕、点、滑、打字、关掉手机（安卓模拟器），玩抖音和 B站。主人打游戏时会自动关机。',
  setup(api) {
    let lastUse = 0
    const enabled = () => Boolean(api.config().phone?.enabled)

    // 自动规则：主人打游戏 → 立刻关机；闲置太久 → 自己关机
    api.every(60_000, async () => {
      if (!enabled()) return
      try {
        if (!(await phoneRunning())) return
        const game = await gameRunning()
        if (game) {
          await phoneOff()
          api.log.info('手机：检测到 ' + game + ' 在前台，已关机')
          return
        }
        const idleMin = Number(api.config().phone?.idleMinutes ?? 20)
        const since = lastUse ? (Date.now() - lastUse) / 60000 : Infinity
        if (since > idleMin) {
          await phoneOff()
          api.log.info('手机：闲置 ' + Math.round(since) + ' 分钟，自己关了')
        }
      } catch (error) {
        api.log.warn('手机自动规则出错：' + (error?.message || error))
      }
    }, '手机自动关机')

    api.tool(({ chat, level }) => {
      if (!enabled() || chat.kind !== 'private' || level !== 'full') return []
      const touch = () => { lastUse = Date.now() }
      return [
        defineTool({
          name: 'phone_on',
          description: '打开你的手机（安卓模拟器）。已经开着会直接返回。开机要半分钟到一分半，耐心等。',
          properties: {},
          execute: async () => {
            touch()
            const r = await phoneOn()
            return { ok: r.ok, message: r.ok ? '手机开好了' : (r.message || '没开起来') }
          },
        }),
        defineTool({
          name: 'phone_look',
          description: '看一眼手机屏幕：返回界面上的文字，以及一张截图。想确认现在在哪个页面、有什么按钮时用。',
          properties: {},
          execute: async () => {
            touch()
            if (!(await phoneRunning())) return { ok: false, message: '手机还没开，先 phone_on' }
            const look = await phoneLook()
            let seen = ''
            try {
              seen = await describeImage(fs.readFileSync(look.file).toString('base64'), '这是安卓手机屏幕截图，用两三句中文说现在是什么应用、什么界面、有没有弹窗。')
            } catch (error) {}
            return { ok: true, message: '屏幕上的字：' + look.texts.join(' / ').slice(0, 600) + (seen ? '\n画面：' + seen : ''), file: look.file }
          },
        }),
        defineTool({
          name: 'phone_tap',
          description: '点手机屏幕上的东西：要么给按钮上的文字（推荐），要么给坐标 x/y。',
          properties: { text: str('要点的按钮或文字，比如「同意」「推荐」「搜索」'), x: int('横坐标，可选'), y: int('纵坐标，可选') },
          execute: async ({ text, x, y }) => {
            touch()
            if (!(await phoneRunning())) return { ok: false, message: '手机还没开' }
            const r = await phoneTap({ text, x, y })
            return { ok: r.ok, message: r.ok ? '点了' : r.message }
          },
        }),
        defineTool({
          name: 'phone_swipe',
          description: '滑屏幕：up 往下看下一个视频，down 上一个，left/right 左右滑。',
          properties: { direction: str('up / down / left / right，默认 up') },
          execute: async ({ direction }) => {
            touch()
            if (!(await phoneRunning())) return { ok: false, message: '手机还没开' }
            const r = await phoneSwipe(direction || 'up')
            return { ok: true, message: '滑了一下（' + r.dir + '）' }
          },
        }),
        defineTool({
          name: 'phone_type',
          description: '在手机输入框里打字。只能打英文数字。',
          properties: { text: str('要打的内容') },
          required: ['text'],
          execute: async ({ text }) => {
            touch()
            if (!(await phoneRunning())) return { ok: false, message: '手机还没开' }
            const r = await phoneType(text)
            return { ok: r.ok, message: r.ok ? '打好了' : r.message }
          },
        }),
        defineTool({
          name: 'phone_key',
          description: '按手机的键：back 返回、home 回桌面。',
          properties: { key: str('back / home') },
          execute: async ({ key }) => {
            touch()
            if (!(await phoneRunning())) return { ok: false, message: '手机还没开' }
            await phoneKey(key || 'back')
            return { ok: true, message: '按了 ' + (key || 'back') }
          },
        }),
        defineTool({
          name: 'phone_launch',
          description: '打开手机上的 App：抖音 或 B站。',
          properties: { app: str('抖音 / B站') },
          required: ['app'],
          execute: async ({ app }) => {
            touch()
            if (!(await phoneRunning())) {
              const on = await phoneOn()
              if (!on.ok) return { ok: false, message: '手机没开起来' }
            }
            const pkg = APPS[String(app || '').trim().toLowerCase()] || APPS[String(app || '').trim()]
            if (!pkg) return { ok: false, message: '只装了抖音和 B站' }
            await phoneLaunch(pkg)
            touch()
            return { ok: true, message: '打开了 ' + app }
          },
        }),
        defineTool({
          name: 'phone_off',
          description: '把手机关掉。玩完了、要省资源、或者感觉到主人在忙的时候，自己关掉。',
          properties: {},
          execute: async () => {
            lastUse = 0
            await phoneOff()
            return { ok: true, message: '手机关了' }
          },
        }),
      ]
    })

    return { state: () => ({ enabled: enabled(), lastUse }) }
  },
}
