// 跟桌宠（dsh-pet）连起来：她说话 → 宠物气泡显示；她也能让宠物走两步。
// 先走插件内部接口；不行就直接挪窗口（Win32），那条最可靠。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOVE_PS = path.join(HERE, 'move-pet.ps1')

export function petApi(dsh) {
  try {
    if (!dsh) return null
    const api = typeof dsh.get === 'function' ? dsh.get('petApi7340') : null
    return api || null
  } catch (error) {
    return null
  }
}

/** 让宠物说一句。 */
export function petSay(dsh, text) {
  const api = petApi(dsh)
  if (!api || typeof api.say !== 'function') return { ok: false, reason: 'no-pet' }
  try { return api.say(text) } catch (error) { return { ok: false, reason: 'error', message: String(error?.message || error) } }
}

/** 直接挪窗口（兜底，也最可靠）。坐标是窗口左上角。 */
export function petMoveOS(x, y) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MOVE_PS, '-X', String(Math.round(x)), '-Y', String(Math.round(y))], { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, reason: 'os-move-failed', message: String(stderr || error.message).slice(0, 160) })
      resolve({ ok: true, detail: String(stdout).trim() })
    })
  })
}

/** 让宠物走到某个位置：先试插件接口，失败就挪窗口。 */
export async function petMove(dsh, x, y) {
  const api = petApi(dsh)
  let first = null
  if (api && typeof api.move === 'function') {
    try { first = api.move(Number(x), Number(y)) } catch (error) { first = { ok: false, message: String(error?.message || error) } }
    if (first && first.ok) return { ok: true, how: 'plugin', x: first.x, y: first.y }
  }
  const os = await petMoveOS(Number(x), Number(y))
  if (os.ok) return { ok: true, how: 'window', detail: os.detail }
  return { ok: false, reason: first?.reason || os.reason, message: first?.message || os.message }
}

export function petList(dsh) {
  const api = petApi(dsh)
  if (!api || typeof api.pets !== 'function') return []
  try { return api.pets() } catch (error) { return [] }
}
