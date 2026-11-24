#!/usr/bin/env node
// Records ONE desktop window (not a browser page) to mp4 with ffmpeg. For apps Playwright can't drive.
//   node record-window.mjs --list
//   node record-window.mjs --title "Window title" --out clip.mp4 [--seconds 120]
// Stops after --seconds, or as soon as the file "<out>.stop" exists (touch it from another shell).
// Windows: gdigrab by exact title. Linux/X11: xdotool + x11grab. macOS: whole screen (no window capture in ffmpeg).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const sh = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8' }).stdout?.trim() ?? '';

if (args.includes('--list')) {
  if (process.platform === 'win32') console.log(sh('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | ? MainWindowTitle | % MainWindowTitle']));
  else if (process.platform === 'linux') console.log(sh('wmctrl', ['-l']) || 'install wmctrl to list windows');
  else console.log('macOS: window listing not supported; records the whole screen');
  process.exit(0);
}

const title = opt('title'), out = opt('out') || 'window.mp4', seconds = opt('seconds') || '120';
if (!title && process.platform !== 'darwin') { console.error('--title is required (see --list)'); process.exit(2); }

const even = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';
const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
let input;
if (process.platform === 'win32' && spawnSync('ffmpeg', ['-v', 'quiet', '-h', 'filter=gfxcapture']).status === 0) {
  // ffmpeg 8+: Windows Graphics Capture records just that window, even when covered. It only emits
  // frames on change (and none while minimized), so fps=30 fills the gaps.
  const re = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '.');
  input = ['-filter_complex', `gfxcapture=window_title='^${re}$':max_framerate=30,hwdownload,format=bgra,fps=30,${even}`];
} else if (process.platform === 'win32') {
  // Older ffmpeg: gdigrab "title=" records black for GPU-composited windows (Chrome, UWP), so bring the
  // window to front and grab its screen rectangle from the desktop instead. The window must stay visible.
  const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type 'using System;using System.Runtime.InteropServices;public struct R{public int L,T,Ri,B;}public static class U{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);[DllImport("dwmapi.dll")]public static extern int DwmGetWindowAttribute(IntPtr h,int a,out R r,int s);}'
[U]::SetProcessDPIAware() | Out-Null
$p = Get-Process | ? { $_.MainWindowTitle -eq $env:PK_TITLE } | select -First 1
if (!$p) { exit 1 }
$h = $p.MainWindowHandle; [U]::ShowWindow($h, 9) | Out-Null; [U]::SetForegroundWindow($h) | Out-Null; Start-Sleep -m 300
$r = New-Object R; [U]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null
"$($r.L) $($r.T) $($r.Ri - $r.L) $($r.B - $r.T)"`;
  const rect = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: { ...process.env, PK_TITLE: title } }).stdout?.trim();
  if (!rect) { console.error(`no window titled exactly "${title}" (see --list)`); process.exit(1); }
  const [x, y, w, h] = rect.split(/\s+/).map(Number);
  input = ['-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '1', '-offset_x', String(x), '-offset_y', String(y), '-video_size', `${w - (w % 2)}x${h - (h % 2)}`, '-i', 'desktop'];
} else if (process.platform === 'linux') {
  const id = sh('xdotool', ['search', '--name', title]).split('\n')[0];
  if (!id) { console.error(`no window matching "${title}"`); process.exit(1); }
  const g = Object.fromEntries(sh('xdotool', ['getwindowgeometry', '--shell', id]).split('\n').map((l) => l.split('=')));
  input = ['-f', 'x11grab', '-framerate', '30', '-video_size', `${g.WIDTH}x${g.HEIGHT}`, '-i', `${process.env.DISPLAY || ':0'}+${g.X},${g.Y}`];
} else input = ['-f', 'avfoundation', '-framerate', '30', '-capture_cursor', '1', '-i', '1:none'];

const stopFile = `${out}.stop`;
rmSync(stopFile, { force: true });
const vf = input.includes('-filter_complex') ? [] : ['-vf', even];
const ff = spawn('ffmpeg', ['-v', 'error', '-y', ...input, '-t', seconds, ...vf, ...enc, out], { stdio: ['pipe', 'inherit', 'inherit'] });
const stop = () => { ff.stdin.write('q'); setTimeout(() => ff.kill(), 5000); }; // kill if no frame ever arrived (e.g. minimized)
const poll = setInterval(() => { if (existsSync(stopFile)) { rmSync(stopFile, { force: true }); stop(); } }, 300);
setTimeout(stop, (Number(seconds) + 3) * 1000).unref();
ff.on('exit', (code) => { clearInterval(poll); console.log(code === 0 ? out : `ffmpeg exited ${code} (window minimized or not found?)`); process.exit(code ?? 1); });
