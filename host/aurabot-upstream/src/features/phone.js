// 她的"手机"：一台跑在 E 盘的安卓模拟器，用 adb 操作。
// 手机不常驻：她要看/玩才开机，玩完自己关；主人打游戏时一律关机。

import { execFile, spawn, execSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'

const run = promisify(execFile)

const SDK = 'E:\\AndroidSdk'
const ADB = SDK + '\\platform-tools\\adb.exe'
const EMULATOR = SDK + '\\emulator\\emulator.exe'
const AVD = 'fish'
const ENV = { ...process.env, ANDROID_AVD_HOME: 'E:\\AndroidAvd', ANDROID_SDK_ROOT: SDK }
const GAMES = ['r5apex', 'cod', 'modernwarfare', 'codmw', 'blackops', 'steam']

async function adb(args, timeoutMs = 20000) {
  const { stdout } = await run(ADB, args, { env: ENV, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' })
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
}

/** 手机开着吗（boot 完成）。 */
export async function phoneRunning() {
  try {
    const out = (await adb(['devices'])).toString()
    if (!/emulator-\d+\s+device/.test(out)) return false
    const boot = (await adb(['shell', 'getprop', 'sys.boot_completed'])).toString().trim()
    return boot === '1'
  } catch (error) {
    return false
  }
}

/** 开机（已经开着就秒回）。 */
export async function phoneOn() {
  if (await phoneRunning()) return { ok: true, already: true }
  const child = spawn(EMULATOR, ['-avd', AVD, '-no-snapshot-save', '-gpu', 'auto', '-no-boot-anim', '-no-metrics'], {
    env: ENV, detached: true, stdio: 'ignore', windowsHide: false,
  })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    if (await phoneRunning()) return { ok: true, seconds: i * 3 }
  }
  return { ok: false, message: '开机超时' }
}

/** 关机。 */
export async function phoneOff() {
  try { await adb(['emu', 'kill'], 8000) } catch (error) {}
  await new Promise((r) => setTimeout(r, 1500))
  try {
    const out = (await adb(['devices'])).toString()
    if (/emulator-\d+/.test(out)) {
      try { execSync('taskkill /IM qemu-system-x86_64.exe /F', { windowsHide: true }) } catch (error) {}
    }
  } catch (error) {}
  return { ok: true }
}

/** 主人是不是在打游戏（前台进程名）。 */
export async function gameRunning() {
  try {
    const { execFile: ef } = await import('node:child_process')
    const ps = promisify(ef)
    const { stdout } = await ps('powershell', ['-NoProfile', '-Command', [
      'Add-Type -TypeDefinition @"',
      'using System; using System.Text; using System.Runtime.InteropServices;',
      'public class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid); }',
      '"@',
      '$h=[FG]::GetForegroundWindow(); $pid2=0; [FG]::GetWindowThreadProcessId($h,[ref]$pid2)|Out-Null',
      '(Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName',
    ].join("\n")], { timeout: 8000, windowsHide: true })
    const name = String(stdout).trim().toLowerCase()
    return GAMES.some((g) => name.includes(g)) ? name : ''
  } catch (error) {
    return ''
  }
}

/** 看一眼手机：截图存到临时目录，返回路径和一个 UI 文字摘要。 */
export async function phoneLook(outDir) {
  await adb(['shell', 'uiautomator', 'dump', '/sdcard/ui.xml'], 25000)
  const xml = (await adb(['shell', 'cat', '/sdcard/ui.xml'])).toString('utf8')
  const texts = [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter(Boolean).slice(0, 40)
  const png = await adb(['exec-out', 'screencap', '-p'], 30000)
  const file = (outDir || process.env.TEMP) + '\\phone-' + Date.now() + '.png'
  fs.writeFileSync(file, png)
  return { file, texts }
}

/** 点一下（坐标或按文字找）。 */
export async function phoneTap({ x, y, text } = {}) {
  if (text) {
    const xml = (await adb(['shell', 'cat', '/sdcard/ui.xml'])).toString('utf8')
    const re = new RegExp('text="' + text.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&') + '"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"')
    const m = xml.match(re)
    if (!m) return { ok: false, message: '屏幕上没有「' + text + '」' }
    x = (Number(m[1]) + Number(m[3])) / 2
    y = (Number(m[2]) + Number(m[4])) / 2
  }
  if (x === undefined || y === undefined) return { ok: false, message: '既没坐标也没文字' }
  await adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))])
  return { ok: true, x: Math.round(x), y: Math.round(y) }
}

/** 滑动：up/down/left/right，模拟刷视频。 */
export async function phoneSwipe(dir = 'up') {
  const [x1, y1, x2, y2] = {
    up: [540, 1700, 540, 600],
    down: [540, 600, 540, 1700],
    left: [900, 1200, 200, 1200],
    right: [200, 1200, 900, 1200],
  }[dir] || [540, 1700, 540, 600]
  await adb(['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), '300'])
  return { ok: true, dir }
}

/** 打字（只支持英文数字；中文要先剪贴板）。 */
export async function phoneType(text) {
  const safe = String(text || '').replace(/[^A-Za-z0-9 _.-]/g, '')
  if (!safe) return { ok: false, message: '只能打英文数字' }
  await adb(['shell', 'input', 'text', safe.replace(/ /g, '%s')])
  return { ok: true }
}

/** 打中文（走 ADBKeyboard 输入法，base64 传，绕开系统输入框限制）。 */
export async function phoneTypeChinese(text) {
  const b64 = Buffer.from(String(text || ''), 'utf8').toString('base64')
  await adb(['shell', 'am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64])
  return { ok: true }
}

export async function phoneKey(key = 'back') {
  const code = { back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', wake: 'KEYCODE_WAKEUP', sleep: 'KEYCODE_SLEEP' }[key] || 'KEYCODE_BACK'
  await adb(['shell', 'input', 'keyevent', code])
  return { ok: true }
}

/** 打开一个装了的 App（包名）。 */
export async function phoneLaunch(pkg) {
  await adb(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], 25000)
  return { ok: true, pkg }
}
