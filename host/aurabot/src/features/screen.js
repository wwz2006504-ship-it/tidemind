// 抓一张屏幕实时画面：主动搭话前先「看一眼」主人在忙什么。
// 走 PowerShell + System.Drawing，退出前把 DPI 感知打开，避免高缩放下只截到左上角。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const PS = (maxWidth) => {
  const w = Math.max(320, Math.min(2560, Number(maxWidth) || 1280))
  return [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class DpiAware { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }',
    '"@',
    '[DpiAware]::SetProcessDPIAware() | Out-Null',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$maxW = ${w}`,
    'if ($bmp.Width -gt $maxW) {',
    '  $h = [int]($bmp.Height * ($maxW / $bmp.Width))',
    '  $small = New-Object System.Drawing.Bitmap $maxW, $h',
    '  $gs = [System.Drawing.Graphics]::FromImage($small)',
    '  $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '  $gs.DrawImage($bmp, 0, 0, $maxW, $h)',
    '  $gs.Dispose()',
    '  $bmp.Dispose()',
    '  $bmp = $small',
    '}',
    '$ms = New-Object System.IO.MemoryStream',
    '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
    '$g.Dispose(); $bmp.Dispose()',
    '[Convert]::ToBase64String($ms.ToArray())',
    '$ms.Dispose()'
  ].join("\n")
}

/**
 * 截当前整个桌面（多屏合起来），缩到 maxWidth 宽，返回 JPEG 的 base64。
 * @returns {Promise<{data:string, mediaType:string, width:number}>}
 */
export async function captureScreen({ maxWidth = 1280, timeoutMs = 20_000 } = {}) {
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS(maxWidth)], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  })
  const data = String(stdout || '').trim()
  if (data.length < 1000) throw new Error('截屏没有拿到画面')
  return { data, mediaType: 'image/jpeg', width: Math.max(320, Math.min(2560, maxWidth)) }
}

/** 前台窗口：进程名 + 标题。没有视觉模型的兜底信息，也够判断「他在打游戏还是在看网页」。 */
export async function foregroundInfo() {
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -TypeDefinition @"',
      'using System; using System.Text; using System.Runtime.InteropServices;',
      'public class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid); }',
      '"@',
      '$h = [Fg]::GetForegroundWindow()',
      '$sb = New-Object System.Text.StringBuilder 512',
      '[Fg]::GetWindowText($h, $sb, 512) | Out-Null',
      '$pid2 = 0',
      '[Fg]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null',
      '$p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue',
      '[Console]::Out.WriteLine(($p.ProcessName) + \"|\" + $sb.ToString())'
    ].join("\n")], { timeout: 8000, windowsHide: true })
    const [process, ...rest] = String(stdout || '').trim().split('|')
    return { process: process || '', title: rest.join('|').slice(0, 120) }
  } catch (error) {
    return { process: '', title: '' }
  }
}

/** 桌面是否有人（有键鼠活动）——暂时用不上，留着给以后判断「他在不在电脑前」。 */
export async function idleSeconds() {
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', [
      'Add-Type -TypeDefinition @"',
      'using System; using System.Runtime.InteropServices;',
      'public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
      'public class Idle { [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p); }',
      '"@',
      '$i = New-Object LASTINPUTINFO',
      '$i.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($i)',
      '[Idle]::GetLastInputInfo([ref]$i) | Out-Null',
      '[int](([Environment]::TickCount - $i.dwTime) / 1000)'
    ].join("\n")], { timeout: 8000, windowsHide: true })
    return Number(String(stdout).trim()) || 0
  } catch (error) {
    return 0
  }
}
