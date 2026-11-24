#!/usr/bin/env node
// Runs a flow file and records proof of it.
//   node proofkit.mjs <flow.mjs> [--demo] [--out <dir>] [--url <url>] [--headed]
// A flow file:
//   export const config = { url, title, subtitle, viewport, label, zoom }
//   export default async ({ page, click, type, press, hover, scroll, shot, chapter, overview, pause }) => { ... }
// --proof (default): screenshots + raw mp4 with Playwright's own action annotations.
// --demo: slow, eased cursor, click ripples, title cards, auto-zoom, framed 1080p mp4.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const flowPath = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(out|url)$/));
if (!flowPath) { console.error('usage: node proofkit.mjs <flow.mjs> [--demo] [--out dir] [--url url] [--headed]'); process.exit(2); }

const flow = await import(pathToFileURL(resolve(flowPath)).href);
const demo = flag('demo');
const cfg = { ...(flow.config || {}) };
cfg.url = opt('url') || cfg.url;
const vp = cfg.viewport || (demo ? { width: 1600, height: 900 } : { width: 1280, height: 800 });
// Headless screencast frames come in CSS px and ignore emulated deviceScaleFactor; forcing Chrome's real
// scale factor gives 2x frames (3200x1800) with the same layout, so the demo zoom stays sharp.
const SF = demo ? 2 : 1;
const launchArgs = demo ? ['--force-device-scale-factor=2'] : [];
const out = resolve(opt('out') || join('.proof', basename(flowPath).replace(/\.m?js$/, '') + (demo ? '-demo' : '')));
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ffmpeg = (a) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
};

let browser;
try { browser = await chromium.launch({ channel: 'chrome', headless: !flag('headed'), args: launchArgs }); }
catch { browser = await chromium.launch({ headless: !flag('headed'), args: launchArgs }); } // bundled chromium: `npx playwright install chromium`
const context = await browser.newContext({ viewport: vp, deviceScaleFactor: SF });
if (demo) await context.addInitScript(CURSOR_SCRIPT());
const page = await context.newPage();

const rawVideo = join(out, demo ? 'raw.webm' : 'video.webm');
await page.screencast.start({ path: rawVideo, size: { width: vp.width * SF, height: vp.height * SF }, fps: demo ? 30 : 25, quality: 90 });
const T0 = Date.now();
const now = () => (Date.now() - T0) / 1000;
const showActions = () => page.screencast.showActions({ duration: 700 });
if (!demo) await showActions();

// ---- flow helpers (same API in both modes; demo versions are slow and eased) ----
const events = []; // demo camera targets: { t0, t1, x, y } or { cut: t }
let mouse = { x: vp.width / 2, y: vp.height / 2 };
let shotN = 0;
const shots = [];
const loc = (t) => (typeof t === 'string' ? page.locator(t) : t);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

async function moveTo(x, y) {
  const from = { ...mouse };
  const dist = Math.hypot(x - from.x, y - from.y);
  const ms = Math.min(1300, Math.max(550, 450 + dist * 0.7));
  const bend = Math.min(80, dist * 0.12) * (x > from.x ? -1 : 1); // slight arc, like a hand
  await page.evaluate(() => window.__pkMount?.()).catch(() => {});
  const start = Date.now();
  for (let t = 0; t < 1;) {
    t = Math.min(1, (Date.now() - start) / ms);
    const e = ease(t), arc = Math.sin(Math.PI * e) * bend;
    const nx = from.x + (x - from.x) * e + arc * ((y - from.y) / (dist || 1));
    const ny = from.y + (y - from.y) * e - arc * ((x - from.x) / (dist || 1));
    await page.mouse.move(nx, ny);
    await sleep(12);
  }
  mouse = { x, y };
}

async function bringIntoView(l) {
  const inView = await l.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  });
  if (!inView) {
    events.push({ cut: now() });
    await l.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(900);
  }
}

// aim 'below': park the arrow's tip on the bottom edge of short (text-like) elements, so its body
// hangs under the text instead of covering it, while the pointer still hovers the element.
// aim 'start': where typed text begins (left, first line), so the camera doesn't detour via the middle.
async function approach(target, aim = 'center') {
  const l = loc(target).first();
  await l.waitFor({ state: 'visible' });
  await bringIntoView(l);
  const b = await l.boundingBox();
  const x = aim === 'start' ? b.x + Math.min(b.width / 2, 40) : b.x + b.width / 2;
  const y = aim === 'below' && b.height < 64 ? b.y + b.height - 3 : aim === 'start' ? b.y + Math.min(b.height / 2, 24) : b.y + b.height / 2;
  const t0 = now();
  await moveTo(x, y);
  await sleep(180);
  return { l, ev: { t0, x, y }, position: { x: x - b.x, y: y - b.y }, box: b };
}

// Viewport position of the text caret in an input, textarea or contenteditable (mirror-div measure).
const caretPoint = (el) => {
  const r = el.getBoundingClientRect();
  if (el.isContentEditable) {
    const rects = getSelection().rangeCount ? getSelection().getRangeAt(0).getClientRects() : [];
    const c = rects[rects.length - 1];
    return c ? { x: c.right, y: c.top + c.height / 2 } : null;
  }
  if (el.selectionEnd == null) return null;
  const cs = getComputedStyle(el), m = document.createElement('div');
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'lineHeight', 'boxSizing',
    'paddingTop', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderLeftWidth', 'borderRightWidth']) m.style[k] = cs[k];
  const area = el.tagName === 'TEXTAREA';
  Object.assign(m.style, { position: 'fixed', visibility: 'hidden', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', borderStyle: 'solid', whiteSpace: area ? 'pre-wrap' : 'pre', overflowWrap: 'break-word' });
  m.textContent = el.value.slice(0, el.selectionEnd);
  const mark = m.appendChild(document.createElement('span'));
  mark.textContent = '​'; // zero-width: marks the caret without moving it
  document.body.appendChild(m);
  const k = mark.getBoundingClientRect();
  m.remove();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  return { x: clamp(k.left - el.scrollLeft, r.left, r.right), y: area ? clamp(k.top + k.height / 2 - el.scrollTop, r.top, r.bottom) : r.top + r.height / 2 };
};

// Cheap fingerprint of what's on screen, to spot actions that change it drastically.
const signature = async () => {
  const read = () => page.evaluate(() => ({
    url: location.href,
    lines: [...new Set((document.body?.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean))].slice(0, 500),
    dialogs: document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]').length,
  }));
  try { return await read(); } catch { await page.waitForLoadState('domcontentloaded').catch(() => {}); return read().catch(() => null); }
};
const drastic = (a, b) => {
  if (!a || !b || a.url !== b.url || b.dialogs > a.dialogs) return true;
  const A = new Set(a.lines), shared = b.lines.filter((l) => A.has(l)).length;
  return shared / (a.lines.length + b.lines.length - shared || 1) < 0.6; // <60% of the text in common
};
const overviewMs = cfg.overview ?? 2000;
async function overview(ms = overviewMs) { events.push({ cut: now(), lead: 0 }); await sleep(ms); } // zoom out, hold the full screen
// Run an action; if it changed the screen drastically, show the whole new screen for a moment.
async function watched(act) {
  const before = overviewMs ? await signature() : null;
  await act();
  await sleep(700);
  if (overviewMs && drastic(before, await signature())) await overview();
}

const kit = {
  page, context, browser, demo, out,
  async click(target, o) {
    if (!demo) return loc(target).first().click(o);
    const { l, ev } = await approach(target);
    await watched(async () => { await l.click(o); events.push({ ...ev, t1: now() }); });
  },
  async type(target, text) {
    if (!demo) return loc(target).first().fill(text);
    const { l, ev, position, box } = await approach(target, 'start');
    await l.click({ position });
    await l.fill(''); // replace, like fill() in proof mode
    events.push({ ...ev, t1: now() });
    await moveTo(ev.x, box.y + box.height + 14); // step aside so the pointer doesn't cover the text
    const follow = async () => { const p = await l.evaluate(caretPoint).catch(() => null); if (p) events.push({ t0: now(), t1: now(), ...p }); };
    let i = 0;
    for (const ch of text) { // camera follows the caret, so long text never runs out of shot
      await page.keyboard.type(ch);
      if (++i % 6 === 0 || ch === '\n') await follow();
      await sleep(45 + Math.random() * 70);
    }
    await follow();
    await sleep(600);
  },
  async hover(target) {
    if (!demo) return loc(target).first().hover();
    const { l, ev, position } = await approach(target, 'below');
    await l.hover({ position });
    events.push({ ...ev, t1: now() });
    await sleep(800);
  },
  async scroll(target) { // locator/selector, or pixels
    events.push({ cut: now() });
    if (typeof target === 'number') await page.evaluate((y) => scrollBy({ top: y, behavior: 'smooth' }), target);
    else await loc(target).first().evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await sleep(demo ? 1100 : 400);
  },
  async shot(name, o = {}) {
    const file = join(out, `${String(++shotN).padStart(2, '0')}-${name}.png`);
    // keep the pointer out of screenshots so it never hides the result
    if (demo) await page.evaluate(() => document.getElementById('__pk_cursor')?.style.setProperty('display', 'none')).catch(() => {});
    else await page.screencast.hideActions();
    await page.screenshot({ path: file, ...o });
    if (demo) await page.evaluate(() => document.getElementById('__pk_cursor')?.style.removeProperty('display')).catch(() => {});
    else await showActions();
    shots.push(file);
    return file;
  },
  async chapter(title, description) {
    if (!demo) { await page.screencast.showChapter(title, { description, duration: 1200 }); return sleep(1200); }
    events.push({ cut: now() });
    await card(title, description, 1800);
  },
  async press(key) {
    if (!demo) return page.keyboard.press(key);
    await watched(() => page.keyboard.press(key));
  },
  overview: (ms) => (demo ? overview(ms) : Promise.resolve()),
  pause: (ms = 1000) => sleep(ms),
};

async function card(title, sub, ms) {
  const esc = (s = '') => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  await page.screencast.showOverlay(`
    <div style="position:fixed;inset:0;display:grid;place-items:center;background:rgba(15,15,30,.55);backdrop-filter:blur(10px);
      font-family:Inter,'Segoe UI',system-ui,sans-serif;animation:pkfade ${ms}ms ease-in-out both">
      <div style="text-align:center;color:#fff;animation:pkrise ${ms}ms cubic-bezier(.2,.8,.2,1) both">
        <div style="font-size:52px;font-weight:700;letter-spacing:-.02em">${esc(title)}</div>
        ${sub ? `<div style="margin-top:14px;font-size:22px;opacity:.8">${esc(sub)}</div>` : ''}
      </div>
      <style>@keyframes pkfade{0%,100%{opacity:0}12%,85%{opacity:1}}@keyframes pkrise{0%{transform:translateY(16px)}25%,100%{transform:none}}</style>
    </div>`, { duration: ms });
  await sleep(ms);
}

// ---- run ----
let failed;
try {
  if (cfg.url) await page.goto(cfg.url, { waitUntil: 'load' });
  if (demo) { await sleep(600); if (cfg.title) await card(cfg.title, cfg.subtitle, 2600); }
  await flow.default(kit);
  await sleep(demo ? 1500 : 800);
} catch (e) {
  failed = e;
  console.error('FLOW FAILED:', e.message);
  await kit.shot('error').catch(() => {});
}
const label = cfg.label || (() => { try { return new URL(page.url()).host; } catch { return ''; } })();
const duration = now();
await page.screencast.stop();

const result = { mode: demo ? 'demo' : 'proof', ok: !failed, error: failed?.message, screenshots: shots, video: rawVideo };
if (!hasFfmpeg) console.error('ffmpeg not found: leaving the .webm as is');
else if (!demo) {
  result.video = rawVideo.replace(/\.webm$/, '.mp4');
  ffmpeg(['-i', rawVideo, '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', result.video]);
  rmSync(rawVideo);
} else if (failed) {
  console.error('demo not rendered because the flow failed; raw recording kept at ' + rawVideo);
} else {
  result.video = join(out, 'demo.mp4');
  await compose(rawVideo, result.video, label);
  rmSync(rawVideo);
}
if (hasFfmpeg && result.video.endsWith('.mp4')) { // 48-frame contact sheet to review the video without playing it
  result.sheet = join(out, 'sheet.png');
  ffmpeg(['-i', result.video, '-vf', `fps=48/${Math.max(duration, 1).toFixed(1)},scale=480:-1,tile=6x8`, '-frames:v', '1', result.sheet]);
}
await browser.close();
console.log(JSON.stringify(result, null, 2));
process.exit(failed ? 1 : 0);

// ---- demo post-production: auto-zoom camera + window frame on a gradient ----
async function compose(input, output, label) {
  const W = 1920, H = 1080, BAR = 44, CW = 1600, CH = Math.round(CW * vp.height / vp.width);
  const X = (W - CW) / 2, Y = Math.round((H - CH - BAR) / 2) + BAR;
  const bg = join(out, '_bg.png'), mask = join(out, '_mask.png');
  const p = await browser.newPage({ viewport: { width: W, height: H } });
  await p.setContent(`<body style="margin:0;width:${W}px;height:${H}px;background:
      radial-gradient(1200px 800px at 15% 10%,#a78bfa 0,transparent 60%),radial-gradient(1000px 700px at 90% 100%,#22d3ee 0,transparent 55%),linear-gradient(135deg,#6366f1,#0ea5e9)">
    <div style="position:absolute;left:${X}px;top:${Y - BAR}px;width:${CW}px;height:${CH + BAR}px;border-radius:14px;background:#fff;
      box-shadow:0 40px 90px rgba(10,10,40,.45),0 0 0 1px rgba(255,255,255,.25);overflow:hidden">
      <div style="height:${BAR}px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;padding:0 16px;gap:8px;font:14px 'Segoe UI',system-ui">
        <i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i>
        <span style="margin:0 auto;padding:4px 60px;border-radius:7px;background:#fff;color:#6b7280">${label.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</span>
      </div></div></body>`);
  await p.screenshot({ path: bg });
  await p.setViewportSize({ width: CW, height: CH });
  await p.setContent(`<body style="margin:0;background:#000"><div style="width:${CW}px;height:${CH}px;background:#fff;border-radius:0 0 14px 14px"></div></body>`);
  await p.screenshot({ path: mask });
  await p.close();

  const zoom = cfg.zoom ?? 1.5;
  const zp = zoom > 1 ? `zoompan=z='${zoomExpr(zoom)}':x='clip(${SF}*${centerExpr('x')}-iw/zoom/2,0,iw-iw/zoom)':y='clip(${SF}*${centerExpr('y')}-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${vp.width * SF}x${vp.height * SF}:fps=30,` : '';
  ffmpeg(['-i', input, '-loop', '1', '-i', bg, '-loop', '1', '-i', mask, '-filter_complex',
    `[0:v]fps=30,${zp}scale=${CW}:${CH}:flags=lanczos,format=rgba[v];[2:v]format=gray[m];[v][m]alphamerge=shortest=1[vm];[1:v][vm]overlay=${X}:${Y}:shortest=1,format=yuv420p`,
    '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', output]);
  rmSync(bg); rmSync(mask);
}

// Camera segments: consecutive actions < 1.6s apart stay zoomed and pan between targets; scrolls/cards cut back to full view.
function segments() {
  const segs = []; let cur;
  for (const e of events) {
    if (e.cut !== undefined) { if (cur) cur.cut = e.cut - (e.lead ?? 0.8); cur = undefined; continue; }
    if (cur && e.t0 - cur.end < 1.6) { cur.end = e.t1; cur.pts.push(e); }
    else segs.push(cur = { start: e.t0, end: e.t1, pts: [e] });
  }
  for (const s of segs) s.end = Math.max(s.start, Math.min(s.end + 0.9, s.cut ?? Infinity)); // cards/scrolls: fully zoomed out by then; overviews: start zooming out then
  return segs;
}
function ss(u) { return `(st(0,clip(${u},0,1))*ld(0)*(3-2*ld(0)))`; } // smoothstep
function zoomExpr(z) {
  const R = 0.7, parts = segments().map((s) => `${ss(`(it-${(s.start - 0.2).toFixed(3)})/${R}`)}*${ss(`(${(s.end + R).toFixed(3)}-it)/${R}`)}`);
  return parts.length ? `1+${(z - 1).toFixed(3)}*min(1,${parts.join('+')})` : '1';
}
function centerExpr(axis) {
  const pts = events.filter((e) => e.cut === undefined);
  if (!pts.length) return axis === 'x' ? 'iw/2' : 'ih/2';
  const mid = vp[axis === 'x' ? 'width' : 'height'] / 2, aim = (e) => mid + (e[axis] - mid) * 0.6;
  let ex = `${aim(pts[0]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) ex += `+${(aim(pts[i]) - aim(pts[i - 1])).toFixed(1)}*${ss(`(it-${pts[i].t0.toFixed(3)})/0.8`)}`;
  return `(${ex})`;
}

function CURSOR_SCRIPT() {
  return `(() => {
  if (window.top !== window) return;
  const svg = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5l15 11.2-6.6.9 3.9 7.4-3 1.5-3.8-7.5L4.5 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  let pos = JSON.parse(sessionStorage.getItem('__pk_pos') || 'null') || { x: innerWidth / 2, y: innerHeight / 2 };
  let c;
  const place = () => c && (c.style.transform = 'translate(' + (pos.x - 5) + 'px,' + (pos.y - 3) + 'px)');
  window.__pkMount = () => {
    if (!document.body || document.getElementById('__pk_cursor')) return;
    const st = document.createElement('style');
    st.textContent = '#__pk_cursor{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}#__pk_cursor svg{transition:transform .12s ease;transform-origin:5px 3px}#__pk_cursor.down svg{transform:scale(.82)}.__pk_ripple{position:fixed;z-index:2147483646;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:rgba(99,102,241,.35);border:2px solid rgba(99,102,241,.9);animation:__pkr .6s cubic-bezier(.2,.8,.2,1) forwards}@keyframes __pkr{to{transform:scale(4.5);opacity:0}}';
    document.head.appendChild(st);
    c = document.createElement('div'); c.id = '__pk_cursor'; c.innerHTML = svg;
    document.body.appendChild(c); place();
  };
  addEventListener('mousemove', (e) => { pos = { x: e.clientX, y: e.clientY }; sessionStorage.setItem('__pk_pos', JSON.stringify(pos)); __pkMount(); place(); }, true);
  addEventListener('mousedown', (e) => {
    c && c.classList.add('down');
    const r = document.createElement('div'); r.className = '__pk_ripple';
    r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
    document.body.appendChild(r); setTimeout(() => r.remove(), 700);
  }, true);
  addEventListener('mouseup', () => c && c.classList.remove('down'), true);
  if (document.body) __pkMount(); else addEventListener('DOMContentLoaded', __pkMount);
})();`;
}
