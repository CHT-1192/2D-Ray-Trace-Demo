#!/usr/bin/env node
/**
 * 端到端验证：Playwright + Ungoogled Chromium。
 *
 * 检查项
 *  1. 真机跑起来有没有 console 报错 / 页面异常
 *  2. 后端确实是 WebGL2
 *  3. 首帧的方块布局与参考截图逐像素提取的结果一致（端到端还原度）
 *  4. 像素级配色：方块填充 0x3D3D3D、远处背景 ≈ 0.318、阴影确实存在
 *  5. exact / edge / uniform 三种算法渲染结果确实不同
 *  6. 单文件 dist/standalone.html 用 file:// 打开同样可用
 *
 * 用法： node scripts/verify.mjs [--url http://127.0.0.1:5177/] [--keep]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const URL_BASE = argOf('--url', 'http://127.0.0.1:5173/');
const OUT = argOf('--out', '/tmp/rt-verify');

// ── Playwright 解析（优先本地，其次全局安装） ────────────────────────────────
async function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/homebrew/lib/node_modules/playwright/index.mjs',
    '/usr/local/lib/node_modules/playwright/index.mjs',
  ];
  for (const c of candidates) {
    try {
      return await import(c.startsWith('/') ? pathToFileURL(c).href : c);
    } catch {
      /* 继续试下一个 */
    }
  }
  throw new Error('找不到 playwright，请先 npm i -D playwright 或全局安装');
}

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Chromium.app/Contents/MacOS/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function findChromium() {
  for (const c of CHROMIUM_CANDIDATES) if (fs.existsSync(c)) return c;
  return undefined; // 交给 playwright 自带的 chromium
}

// ── 极简 PNG 解码（只处理 8bit RGB/RGBA/灰度，够分析截图用） ────────────────
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let w = 0;
  let h = 0;
  let bd = 0;
  let ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8) throw new Error(`暂不支持 bitDepth=${bd}`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (!ch) throw new Error(`暂不支持 colorType=${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch;
      const d = (y * w + x) * 4;
      if (ch >= 3) {
        out[d] = cur[s];
        out[d + 1] = cur[s + 1];
        out[d + 2] = cur[s + 2];
        out[d + 3] = ch === 4 ? cur[s + 3] : 255;
      } else {
        out[d] = out[d + 1] = out[d + 2] = cur[s];
        out[d + 3] = ch === 2 ? cur[s + 1] : 255;
      }
    }
    prev = cur;
  }
  return { w, h, data: out };
}

const gray = (img, x, y) => {
  const i = (y * img.w + x) * 4;
  return Math.round(0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]);
};

/** 阈值 + 连通域，用来从截图里反推方块位置（和当初解析参考图用的是同一套办法）。 */
function findRects(img, threshold = 70, minArea = 900) {
  const { w, h } = img;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = i * 4;
    mask[i] = 0.299 * img.data[d] + 0.587 * img.data[d + 1] + 0.114 * img.data[d + 2] <= threshold ? 1 : 0;
  }
  const label = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const rects = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const id = rects.length;
    let sp = 0;
    stack[sp++] = i;
    label[i] = id;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) (label[p - 1] = id), (stack[sp++] = p - 1);
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) (label[p + 1] = id), (stack[sp++] = p + 1);
      if (y > 0 && mask[p - w] && label[p - w] < 0) (label[p - w] = id), (stack[sp++] = p - w);
      if (y < h - 1 && mask[p + w] && label[p + w] < 0) (label[p + w] = id), (stack[sp++] = p + w);
    }
    if (area >= minArea) rects.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  return rects.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** 参考截图 (1200×685) 里提取出来的 16 个方块（见 src/core/layout.ts 的来源说明）。 */
const REFERENCE_RECTS = [
  { x: 243, y: 16, w: 141, h: 94 },
  { x: 960, y: 36, w: 141, h: 95 },
  { x: 749, y: 67, w: 141, h: 70 },
  { x: 502, y: 80, w: 203, h: 125 },
  { x: 81, y: 97, w: 130, h: 86 },
  { x: 261, y: 145, w: 203, h: 92 },
  { x: 949, y: 161, w: 207, h: 71 },
  { x: 811, y: 172, w: 59, h: 60 },
  { x: 209, y: 420, w: 146, h: 102 },
  { x: 958, y: 442, w: 145, h: 103 },
  { x: 736, y: 476, w: 148, h: 76 },
  { x: 479, y: 490, w: 212, h: 136 },
  { x: 40, y: 508, w: 135, h: 94 },
  { x: 227, y: 561, w: 213, h: 100 },
  { x: 945, y: 578, w: 215, h: 77 },
  { x: 800, y: 590, w: 63, h: 66 },
];

// ── 断言 ────────────────────────────────────────────────────────────────────
let pass = 0;
const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
  } else {
    fails.push(name);
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
  }
};
const section = (t) => console.log(`\n\u001b[1m${t}\u001b[0m`);

/** 整图平均灰度（判断整体明暗变化用） */
function meanGray(img) {
  let sum = 0;
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    sum += 0.299 * img.data[d] + 0.587 * img.data[d + 1] + 0.114 * img.data[d + 2];
  }
  return sum / n;
}

function meanAbsDiff(a, b) {
  const n = Math.min(a.data.length, b.data.length);
  let sum = 0;
  let changed = 0;
  const px = n / 4;
  for (let i = 0; i < n; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]);
    sum += d;
    if (d > 12) changed++;
  }
  return { mean: sum / px, changedRatio: changed / px };
}

// ── 目标不可达就自己起一个临时服务器（方便 `npm run verify` 一条命令跑通） ──
async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

let ownServer = null;
if (!(await reachable(URL_BASE))) {
  const port = new URL(URL_BASE).port || '5173';
  console.log(`[verify] ${URL_BASE} 不可达，自动启动临时服务器（端口 ${port}）…`);
  ownServer = spawn(process.execPath, [path.join(root, 'server/server.mjs'), '--port', port], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 150));
    up = await reachable(URL_BASE);
  }
  if (!up) {
    ownServer.kill();
    throw new Error(`临时服务器启动失败：${URL_BASE}`);
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const { chromium } = await loadPlaywright();
const executablePath = findChromium();
fs.mkdirSync(OUT, { recursive: true });

console.log(`\u001b[1mPlaywright 验证\u001b[0m  chromium=${executablePath ?? '(playwright 自带)'}`);

const browser = await chromium.launch({
  executablePath,
  args: ['--enable-unsafe-swiftshader', '--allow-file-access-from-files'],
});
const context = await browser.newContext({
  viewport: { width: 1200, height: 685 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
});
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

async function shoot(name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  return { file, img: decodePng(fs.readFileSync(file)) };
}

async function hideUi() {
  await page.evaluate(() => {
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = 'none';
  });
}

async function showUi() {
  await page.evaluate(() => {
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = '';
  });
}

async function waitFrames(n = 3) {
  await page.evaluate(
    (k) =>
      new Promise((resolve) => {
        let i = 0;
        const step = () => (++i >= k ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );
}

section('1. 加载与后端');
await page.goto(new URL('/', URL_BASE).href, { waitUntil: 'load' });
await page.waitForFunction(() => Boolean(window.__RT2D__), null, { timeout: 15000 });
await waitFrames(5);

const info = await page.evaluate(() => {
  const api = window.__RT2D__;
  const gl = api.renderer.backend === 'webgl2' ? document.getElementById('stage').getContext('webgl2') : null;
  return {
    backend: api.renderer.backend,
    detail: api.renderer.detail,
    stats: { ...api.stats },
    opts: { ...api.opts },
    webglVersion: gl ? gl.getParameter(gl.VERSION) : null,
    hudBackend: document.querySelector('[data-backend]')?.textContent ?? null,
  };
});
check('后端是 WebGL2', info.backend === 'webgl2', `${info.detail}`);
check('存在 __RT2D__ 调试句柄且 HUD 已挂载', Boolean(info.hudBackend), `${info.hudBackend}`);
check('无 pageerror', pageErrors.length === 0, pageErrors.join(' | ') || '无');
check('无 console 报错', consoleErrors.length === 0, consoleErrors.join(' | ') || '无');
check(
  '几何规模合理',
  info.stats.segments >= 44 && info.stats.vertices >= 10 && info.stats.rays === info.stats.segments,
  `${info.stats.segments} 条线段 / ${info.stats.vertices} 顶点 / ${info.stats.rays} 条射线`,
);

section('2. 程序化生成的首帧');
await hideUi();
await page.evaluate(() => {
  const api = window.__RT2D__;
  api.opts.paused = true;
  api.opts.debugRays = false;
  api.opts.showBlocks = true;
  api.applySeed(20260910);
});
await waitFrames(4);
const first = await shoot('01-generated-frame');
const rects = findRects(first.img);
check('首帧就有成规模的方块', rects.length >= 10 && rects.length <= 30, `${rects.length} 个`);

const W_MIN = 48;
const W_MAX = 232;
const H_MIN = 44;
const H_MAX = 152;
const badSize = rects.filter((r) => r.w < W_MIN || r.w > W_MAX || r.h < H_MIN || r.h > H_MAX);
check(
  '尺寸都落在拟合出来的区间内',
  badSize.length === 0,
  badSize.length ? `越界 ${badSize.map((r) => `${r.w}x${r.h}`).join(' ')}` : `宽度 ${Math.min(...rects.map((r) => r.w))}~${Math.max(...rects.map((r) => r.w))}，高度 ${Math.min(...rects.map((r) => r.h))}~${Math.max(...rects.map((r) => r.h))}`,
);

// 中间那条带要留给灯泡（和参考图一样），否则一开局就全黑
const lightY = 325;
const blocksInLightBand = rects.filter((r) => r.y <= lightY && r.y + r.h >= lightY);
check('灯泡所在的横带没有被方块占据', blocksInLightBand.length === 0, `${blocksInLightBand.length} 个压住灯泡`);

// 参考图那 16 个方块不应该原样出现 —— 已经不做「复刻参考图」了
const refKeys = new Set(REFERENCE_RECTS.map((r) => `${r.x},${r.y},${r.w},${r.h}`));
const clones = rects.filter((r) => refKeys.has(`${r.x},${r.y},${r.w},${r.h}`));
check('没有原样复刻参考图里的方块', clones.length === 0, `${clones.length} 个重合`);

section('3. 像素级配色与硬阴影');
section('3. 像素级配色与硬阴影');
const img = first.img;
const glow = await page.evaluate(() => ({ ...window.__RT2D__.settings }));

const biggest = [...rects].sort((a, b) => b.w * b.h - a.w * a.h)[0];
const fillSample = gray(img, Math.round(biggest.x + biggest.w / 2), Math.round(biggest.y + biggest.h / 2));
check(
  '方块填充 = 0x3D3D3D (61)',
  Math.abs(fillSample - 61) <= 3,
  `最大方块 (${biggest.x},${biggest.y} ${biggest.w}x${biggest.h}) 内部实测 ${fillSample}`,
);
// 远处角落（大概率在阴影里）应该等于「环境光」那一层：
//   bgFar + glowAmp·(1-directShare)·f(d)   —— 万一它是亮的，则等于全亮值。
// 参考图那套 R=700 时这里是 81；范围调大后自然更亮，所以对模型验而不是对旧值验。
const cornerSample = gray(img, 12, 12);
const dCorner = Math.hypot(12 - 600, 12 - 325);
const fCorner = Math.pow(Math.max(0, 1 - dCorner / glow.glowRadius), glow.glowPower);
const ambientAt = 255 * (glow.bgFar + glow.glowAmp * (1 - glow.directShare) * fCorner);
const fullAt = 255 * (glow.bgFar + glow.glowAmp * fCorner);
check(
  '远处角落亮度符合环境光模型',
  Math.min(Math.abs(cornerSample - ambientAt), Math.abs(cornerSample - fullAt)) <= 8,
  `实测 ${cornerSample}，模型：阴影 ${ambientAt.toFixed(0)} / 全亮 ${fullAt.toFixed(0)}`,
);
check('灯泡是白的', gray(img, 600, 325) >= 250, `实测 ${gray(img, 600, 325)}`);

// 亮区衰减：对着「页面里当前配置的模型」验，而不是写死参考图那条曲线
// （光照范围是可调项，参考图那套 R=700/p=1.16 只够铺到画面中部）
const modelAt = (d) => 255 * (glow.bgFar + glow.glowAmp * Math.pow(Math.max(0, 1 - d / glow.glowRadius), glow.glowPower));
let falloffWorst = 0;
const falloffSamples = [
  [700, 325],
  [800, 325],
  [900, 325],
];
for (const [x, y] of falloffSamples) {
  const d = Math.hypot(x - 600, y - 325);
  falloffWorst = Math.max(falloffWorst, Math.abs(gray(img, x, y) - modelAt(d)));
}
check(
  '亮区衰减与配置的模型一致（3 个半径，误差 ≤ 8/255）',
  falloffWorst <= 8,
  `R=${glow.glowRadius} p=${glow.glowPower}，最大误差 ${falloffWorst.toFixed(1)}/255`,
);

// 范围：画面最远的角（≈690）也要被照亮，否则「亮光范围」就还是只到中部
const cornerD = Math.hypot(600, 325);
const cornerGlow = Math.pow(Math.max(0, 1 - cornerD / glow.glowRadius), glow.glowPower);
check(
  '亮光铺得到画面最远的角',
  cornerGlow > 0.2,
  `最远角 d≈${cornerD.toFixed(0)}，辉光仍有 ${(cornerGlow * 100).toFixed(0)}%（参考图那套只有 1.4%）`,
);

// 灯泡剖面逐点比对（这些数字是从参考截图 (600+r, 325) 上直接量出来的）
const REF_DOT = [
  [0, 255],
  [2, 250],
  [4, 242],
  [6, 215],
  [8, 183],
  [10, 150],
  [12, 158],
  [14, 154],
  [18, 153],
];
let dotWorst = 0;
const dotTrace = [];
for (const [r, want] of REF_DOT) {
  const got = gray(img, 600 + r, 325);
  dotWorst = Math.max(dotWorst, Math.abs(got - want));
  dotTrace.push(`${r}:${got}/${want}`);
}
check('灯泡径向剖面与参考图一致（误差 ≤ 12/255）', dotWorst <= 12, `最大误差 ${dotWorst}  「${dotTrace.join(' ')}」`);

// 硬阴影：同一半径圆上，被方块挡住的方位必须明显比没挡住的暗
const ring = await page.evaluate(() => {
  const api = window.__RT2D__;
  const { x: lx, y: ly } = api.scene.light;
  const samples = [];
  for (let i = 0; i < 720; i++) {
    const a = (i / 720) * Math.PI * 2;
    const px = lx + Math.cos(a) * 150;
    const py = ly + Math.sin(a) * 150;
    if (px < 0 || py < 0 || px > api.scene.worldW - 1 || py > api.scene.worldH - 1) continue;
    samples.push([Math.round(px), Math.round(py)]);
  }
  return samples;
});
let dark = 0;
let bright = 0;
const values = ring.map(([x, y]) => gray(img, x, y));
for (const v of values) (v < 100 ? dark++ : bright++);
check('半径 150 的圆环上同时存在亮区与阴影区', dark > 20 && bright > 20, `暗 ${dark} / 亮 ${bright} 像素`);
const litAvg = values.filter((v) => v >= 100).reduce((a, b) => a + b, 0) / Math.max(1, bright);
const darkAvg = values.filter((v) => v < 100).reduce((a, b) => a + b, 0) / Math.max(1, dark);
check('亮区/阴影区亮度差 > 25', litAvg - darkAvg > 25, `亮 ${litAvg.toFixed(0)} vs 暗 ${darkAvg.toFixed(0)}`);

section('4. 三种算法渲染结果确实不同');
// 关键：三种算法必须在同一帧几何下比较，否则差异全来自方块位移
const freeze = async (offset) => {
  await page.evaluate((o) => {
    const api = window.__RT2D__;
    api.opts.paused = true;
    api.opts.debugRays = false;
    api.opts.showBlocks = true;
    api.scene.scrollX = o;
    api.relayout();
  }, offset);
  await waitFrames(3);
};
await freeze(137);
await page.keyboard.press('Digit1');
await waitFrames(3);
const exact = await shoot('02-mode-exact');
const exactStats = await page.evaluate(() => ({ ...window.__RT2D__.stats }));

await page.keyboard.press('Digit3');
await waitFrames(3);
const uniform = await shoot('03-mode-uniform');
const uniformStats = await page.evaluate(() => ({ ...window.__RT2D__.stats }));

await page.keyboard.press('Digit2');
await waitFrames(3);
const edge = await shoot('04-mode-edge');
const edgeStats = await page.evaluate(() => ({ ...window.__RT2D__.stats }));
check(
  '每种算法的射线数符合各自定义',
  exactStats.rays < 100 && edgeStats.rays === exactStats.rays * 3 && uniformStats.rays === 360,
  `exact ${exactStats.rays} / edge ${edgeStats.rays} / uniform ${uniformStats.rays}`,
);

const dEU = meanAbsDiff(exact.img, uniform.img);
const dEE = meanAbsDiff(exact.img, edge.img);
check('exact 模式射线数远小于 uniform', exactStats.rays < uniformStats.rays / 3, `${exactStats.rays} vs ${uniformStats.rays}`);
check('exact 与 uniform 画面不同（阴影边缘位置不同）', dEU.changedRatio > 0.002, `平均差 ${dEU.mean.toFixed(2)}，${(dEU.changedRatio * 100).toFixed(3)}% 像素不同`);
check('exact 与 edge 画面接近但不完全相同', dEE.changedRatio > 0 && dEE.changedRatio < dEU.changedRatio, `平均差 ${dEE.mean.toFixed(3)}，${(dEE.changedRatio * 100).toFixed(3)}% 像素不同`);

section('4b. 真实滚动：从左往右平移');
await hideUi();
await page.evaluate(() => {
  const api = window.__RT2D__;
  api.opts.mode = 'exact';
  api.opts.speed = 120;
  api.opts.debugRays = false;
  api.opts.showBlocks = true;
  api.opts.paused = false;
  api.applySeed(20260910);
  api.relayout();
});
await waitFrames(3);
const clockA = await page.evaluate(() => ({ offset: window.__RT2D__.scene.scrollX, t: performance.now() }));
const moveA = await shoot('09-scroll-t0');
await page.waitForTimeout(1000);
const clockB = await page.evaluate(() => ({ offset: window.__RT2D__.scene.scrollX, t: performance.now() }));
const moveB = await shoot('09-scroll-t1');

const elapsed = (clockB.t - clockA.t) / 1000;
const offsetDelta = ((clockB.offset - clockA.offset) % 1200 + 1200) % 1200;
check(
  '引擎位移 = 速度 × 时间（120/s）',
  Math.abs(offsetDelta - 120 * elapsed) <= 6,
  `实测 ${offsetDelta.toFixed(1)}px / ${elapsed.toFixed(3)}s`,
);

// 用 (y, w, h) 作特征匹配同一个方块：它应该整体右移了 offsetDelta。
// 生成器会同时产生全新方块，所以只要求大部分能配上。
const rectsA = findRects(moveA.img);
const rectsB = findRects(moveB.img);
let pairs = 0;
let shifted = 0;
for (const a of rectsA) {
  const cands = rectsB.filter((r) => Math.abs(r.y - a.y) <= 1 && Math.abs(r.w - a.w) <= 1 && Math.abs(r.h - a.h) <= 1);
  if (cands.length !== 1) continue;
  pairs++;
  if (Math.abs(cands[0].x - a.x - offsetDelta) <= 5) shifted++;
}
check(
  '同一方块的像素位移 = 引擎位移（±5px）',
  pairs >= 6 && shifted >= pairs - 1,
  `命中 ${shifted}/${pairs}（A 帧检出 ${rectsA.length} 个，B 帧 ${rectsB.length} 个）`,
);

section('4c. 程序化生成：尺寸不再局限于参考图的 16 个值');
// 引擎层面快进 90 秒（种子固定，结果可复现），统计这段时间里出现过的所有宽度
const genStats = await page.evaluate(() => {
  const api = window.__RT2D__;
  api.opts.paused = true;
  api.scene.generate(987654321);
  api.relayout();
  const widths = new Set();
  const heights = new Set();
  for (let i = 0; i < 5400; i++) {
    api.scene.update(1 / 60, 150);
    for (const b of api.scene.blocks) {
      widths.add(b.w);
      heights.add(b.h);
    }
  }
  return { widths: widths.size, heights: heights.size, spawned: api.scene.spawned, live: api.scene.blocks.length };
});
const refWidthSet = new Set(REFERENCE_RECTS.map((r) => r.w));
check(
  '90 秒内出现过的宽度种类远多于参考图的 13 种',
  genStats.widths > 60,
  `${genStats.widths} 种宽度 / ${genStats.heights} 种高度（参考图 13 种宽度），期间生成 ${genStats.spawned} 个方块`,
);

await waitFrames(3);
const gen = await shoot('12-generated');
const genRects = findRects(gen.img);
const novelWidths = [...new Set(genRects.map((r) => r.w).filter((w) => ![...refWidthSet].some((r) => Math.abs(r - w) <= 2)))];
check(
  '画面上确实出现了参考图里没有的尺寸',
  genRects.length >= 8 && novelWidths.length >= 3,
  `新宽度 ${novelWidths.slice(0, 8).join(',')}（本帧共 ${genRects.length} 个方块）`,
);
const genDiff = meanAbsDiff(gen.img, first.img);
check('快进后的布局与首帧差异显著（世界在持续变化）', genDiff.changedRatio > 0.15, `${(genDiff.changedRatio * 100).toFixed(1)}% 像素不同`);

section('5. 交互与调试视图');
await page.evaluate(() => {
  const api = window.__RT2D__;
  api.applySeed(20260910);
  api.opts.paused = true;
});
await freeze(137);
await page.keyboard.press('Digit1');
await page.keyboard.press('KeyR');
await waitFrames(3);
const rays = await shoot('05-debug-rays');
check('调试射线视图能截到画面', rays.img.w === 1200 && rays.img.h === 685);
await page.keyboard.press('KeyR');
await freeze(137);
await page.keyboard.press('KeyB');
await waitFrames(3);
const noBlocks = await shoot('06-no-blocks');
const dn = meanAbsDiff(exact.img, noBlocks.img);
check('隐藏方块后画面变化（可见多边形本体）', dn.changedRatio > 0.02, `${(dn.changedRatio * 100).toFixed(2)}% 像素不同`);
await page.keyboard.press('KeyB');

section('6. 单文件版（file:// 直接打开）');
const standalone = await context.newPage();
const saErrors = [];
standalone.on('pageerror', (e) => saErrors.push(String(e)));
standalone.on('console', (m) => {
  if (m.type() === 'error') saErrors.push(m.text());
});
const saPath = path.join(root, 'dist/standalone.html');
await standalone.goto(pathToFileURL(saPath).href, { waitUntil: 'load' });
await standalone.waitForFunction(() => Boolean(window.__RT2D__), null, { timeout: 15000 });
await standalone.evaluate(() => {
  const api = window.__RT2D__;
  api.opts.paused = true;
  api.applySeed(20260910);
  api.relayout();
  const ui = document.getElementById('ui');
  if (ui) ui.style.display = 'none';
});
await standalone.evaluate(
  () =>
    new Promise((r) => {
      let i = 0;
      const step = () => (++i >= 4 ? r() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    }),
);
const saFile = path.join(OUT, '07-standalone.png');
await standalone.screenshot({ path: saFile });
const saImg = decodePng(fs.readFileSync(saFile));
const saRects = findRects(saImg);
const saInfo = await standalone.evaluate(() => ({ backend: window.__RT2D__.renderer.backend, stats: { ...window.__RT2D__.stats } }));
check('file:// 下单文件版可运行', Boolean(saInfo.backend), `${saInfo.backend} / ${saInfo.stats.segments} 条线段`);
check('单文件版同样生成了成规模的方块', saRects.length >= 8, `检出 ${saRects.length} 个`);
check('单文件版无报错', saErrors.length === 0, saErrors.join(' | ') || '无');
const saDiff = meanAbsDiff(saImg, first.img);
check('单文件版与站点版首帧画面一致（<0.5% 像素不同）', saDiff.changedRatio < 0.005, `${(saDiff.changedRatio * 100).toFixed(3)}% 像素不同`);

section('7. Canvas2D 回退路径');
const noGl = await context.newPage();
const noGlErrors = [];
noGl.on('pageerror', (e) => noGlErrors.push(String(e)));
await noGl.addInitScript(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (type === 'webgl2' || type === 'webgl') return null;
    return orig.call(this, type, ...rest);
  };
});
await noGl.goto(new URL('/', URL_BASE).href, { waitUntil: 'load' });
await noGl.waitForFunction(() => Boolean(window.__RT2D__), null, { timeout: 15000 });
await noGl.evaluate(() => {
  const api = window.__RT2D__;
  api.opts.paused = true;
  api.applySeed(20260910);
  api.relayout();
  const ui = document.getElementById('ui');
  if (ui) ui.style.display = 'none';
});
await noGl.evaluate(
  () =>
    new Promise((r) => {
      let i = 0;
      const step = () => (++i >= 4 ? r() : requestAnimationFrame(step));
      requestAnimationFrame(step);
    }),
);
const fallbackFile = path.join(OUT, '08-canvas2d-fallback.png');
await noGl.screenshot({ path: fallbackFile });
const fbImg = decodePng(fs.readFileSync(fallbackFile));
const fbRects = findRects(fbImg);
const fbInfo = await noGl.evaluate(() => ({ backend: window.__RT2D__.renderer.backend }));
check('禁用 WebGL 后自动回退到 Canvas2D', fbInfo.backend === 'canvas2d', fbInfo.backend);
check('回退后画面依然正确', fbRects.length >= 8, `检出 ${fbRects.length} 个方块`);
check('回退路径无报错', noGlErrors.length === 0, noGlErrors.join(' | ') || '无');

section('8. 可复现性：同种子 ⇒ 同一个世界');
await hideUi();
const shotAt = async (seed, name) => {
  await page.evaluate((v) => {
    const api = window.__RT2D__;
    api.opts.paused = true;
    api.opts.debugRays = false;
    api.opts.showBlocks = true;
    api.applySeed(v);
  }, seed);
  await waitFrames(4);
  return shoot(name);
};

const seedA = await shotAt(1234, '14-seed-1234-a');
const seedB = await shotAt(9999, '15-seed-9999');
const seedA2 = await shotAt(1234, '16-seed-1234-b');

const repeat = meanAbsDiff(seedA.img, seedA2.img);
check('同种子两次生成，画面逐像素一致', repeat.changedRatio === 0 && repeat.mean === 0, `平均差 ${repeat.mean}，差异像素 ${(repeat.changedRatio * 100).toFixed(3)}%`);

const diffSeed = meanAbsDiff(seedA.img, seedB.img);
check('不同种子画面明显不同', diffSeed.changedRatio > 0.1, `${(diffSeed.changedRatio * 100).toFixed(1)}% 像素不同`);

const hash = await page.evaluate(() => location.hash);
check('地址栏反映了当前种子', hash === '#seed=1234', hash);

// 引擎层面：换种子再换回来，方块列表逐位一致
const determinism = await page.evaluate(() => {
  const api = window.__RT2D__;
  const print = () => api.scene.blocks.map((b) => `${b.id}:${b.x}:${b.y}:${b.w}:${b.h}`).join('|');
  api.applySeed(4321);
  const a = print();
  api.applySeed(8765);
  api.applySeed(4321);
  const b = print();
  return { same: a === b, n: api.scene.blocks.length, seed: api.scene.seed };
});
check('切走再切回同一颗种子，方块列表逐位一致', determinism.same, `${determinism.n} 个方块，seed=${determinism.seed}`);

// 直接用带 hash 的链接打开两个新页面：验证「分享链接即可复现」
async function shootUrl(url, name) {
  const pg = await context.newPage();
  await pg.goto(url, { waitUntil: 'load' });
  await pg.waitForFunction(() => Boolean(window.__RT2D__), null, { timeout: 15000 });
  const seed = await pg.evaluate(() => {
    const api = window.__RT2D__;
    api.opts.paused = true;
    api.scene.scrollX = 0; // 归一化滚动位置，只比较「种子决定的世界」
    api.scene.rebuild();
    const ui = document.getElementById('ui');
    if (ui) ui.style.display = 'none';
    return api.scene.seed;
  });
  await pg.evaluate(
    () =>
      new Promise((r) => {
        let i = 0;
        const step = () => (++i >= 4 ? r() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
  );
  const file = path.join(OUT, `${name}.png`);
  await pg.screenshot({ path: file });
  await pg.close();
  return { seed, img: decodePng(fs.readFileSync(file)) };
}

const sharedUrl = new URL('/', URL_BASE).href + '#seed=777';
const h1 = await shootUrl(sharedUrl, '17-hash-seed-a');
const h2 = await shootUrl(sharedUrl, '18-hash-seed-b');
check('链接里的 #seed 被正确读取', h1.seed === 777 && h2.seed === 777, `seed=${h1.seed} / ${h2.seed}`);
const hashDiff = meanAbsDiff(h1.img, h2.img);
check('同一个带种子的链接打开两次，画面逐像素一致', hashDiff.changedRatio === 0 && hashDiff.mean === 0, `平均差 ${hashDiff.mean}`);

section('9. 计时读数（亚毫秒测量）');
// performance.now() 在这台机器上只有 0.1ms 精度，而可见性求解只要几十微秒：
// 直接单次计时只会得到「0 或 0.1ms」两个值（HUD 上表现为「不是 1µs 就是 1.00ms」）。
// 这里验证 HUD 走的是批量计时，读数有意义、且随算法变化。
const parseDisplayedMs = (txt) => {
  const m = /^([\d.]+)\s*(µs|ms)$/.exec((txt || '').trim());
  if (!m) return NaN;
  const v = Number(m[1]);
  return m[2] === 'µs' ? v / 1000 : v;
};

const readTiming = async () => {
  await page.waitForTimeout(1100);
  return page.evaluate(() => {
    let tick = Infinity;
    let prev = performance.now();
    for (let i = 0; i < 300000 && tick === Infinity; i++) {
      const t = performance.now();
      if (t > prev) tick = t - prev;
    }
    const meter = window.__RT2D__.solveMeter;
    return {
      text: document.querySelector('[data-stat="vis"]').textContent,
      k: meter.lastBatch.k,
      elapsed: meter.lastBatch.elapsed,
      tick,
      rays: window.__RT2D__.stats.rays,
      segments: window.__RT2D__.stats.segments,
    };
  });
};

await page.evaluate(() => {
  const api = window.__RT2D__;
  api.opts.paused = true;
  api.opts.mode = 'exact';
  api.solveMeter.invalidate();
});
const exactT = await readTiming();
const exactMs = parseDisplayedMs(exactT.text);
check('HUD 的求解耗时是可解析的有效值', Number.isFinite(exactMs) && exactMs > 0, `显示 "${exactT.text}"`);
check(
  '批量跨越足够多的时钟刻度（量化误差 ≤ 12.5%）',
  exactT.elapsed >= exactT.tick * 8,
  `一批 ${exactT.k} 次 / ${exactT.elapsed.toFixed(2)}ms，时钟刻度 ${(exactT.tick * 1000).toFixed(0)}µs`,
);
check(
  '读数远小于一个时钟刻度（说明确实是批量测出来的）',
  exactMs < exactT.tick,
  `求解 ${(exactMs * 1000).toFixed(1)}µs < 刻度 ${(exactT.tick * 1000).toFixed(0)}µs`,
);

await page.evaluate(() => {
  const api = window.__RT2D__;
  api.opts.mode = 'uniform';
  api.solveMeter.invalidate();
});
const uniformT = await readTiming();
const uniformMs = parseDisplayedMs(uniformT.text);
check(
  '读数随算法变化：uniform 360 条明显慢于 exact',
  Number.isFinite(uniformMs) && uniformMs > exactMs * 1.5,
  `exact ${(exactMs * 1000).toFixed(1)}µs（${exactT.rays} 条射线） vs uniform ${(uniformMs * 1000).toFixed(1)}µs（${uniformT.rays} 条）`,
);

section('10. 高级参数面板（实时调参）');
await page.evaluate(() => {
  const api = window.__RT2D__;
  api.opts.paused = true;
  api.opts.mode = 'exact';
  api.settings.glowRadius = 1050; // 从默认值开始
});
await waitFrames(3);

check('面板默认是收起的', await page.evaluate(() => document.getElementById('advanced').hidden));
await page.keyboard.press('KeyA');
await waitFrames(3);
check('按 A 能打开高级面板', await page.evaluate(() => !document.getElementById('advanced').hidden));

// 基准图要在面板打开之后截，两张图的面板状态才一致
const before = await shoot('19-adv-before');

const knobCount = await page.evaluate(() => document.querySelectorAll('#advanced [data-knob]').length);
check('面板里列出的实时参数数量', knobCount >= 20, `${knobCount} 个滑块`);

// 拖「光照范围」到最大：角落应该立刻变亮
await page.evaluate(() => {
  const el = document.querySelector('#advanced [data-knob="glowRadius"]');
  el.value = el.max;
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await waitFrames(3);
const brighter = await shoot('20-adv-glow-max');
const cornerBefore = gray(before.img, 12, 12);
const cornerAfter = gray(brighter.img, 12, 12);
check(
  '拖动「光照范围」立即生效（角落变亮）',
  cornerAfter - cornerBefore >= 8,
  `角落 ${cornerBefore} → ${cornerAfter}（设置值 ${await page.evaluate(() => window.__RT2D__.settings.glowRadius)}）`,
);

// 拖「阴影深度」：directShare 是「辉光里会被遮挡的比例」，
// 亮区总亮度与它无关，只有阴影区会变暗 —— 所以看整图平均灰度。
const meanLit = meanGray(brighter.img);
await page.evaluate(() => {
  const el = document.querySelector('#advanced [data-knob="directShare"]');
  el.value = el.max;
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await waitFrames(3);
const darker = await shoot('21-adv-shadow-max');
const meanShadow = meanGray(darker.img);
check(
  '拖动「阴影深度」立即生效（阴影区变暗、整图均值下降）',
  meanLit - meanShadow >= 1.5,
  `整图均值 ${meanLit.toFixed(2)} → ${meanShadow.toFixed(2)}`,
);

// 恢复默认（点完把鼠标挪开，否则按钮的 hover 高亮会留在截图里）
await page.locator('#advanced .reset').click();
await page.mouse.move(600, 640);
await waitFrames(3);
check(
  '「恢复默认值」把参数改回去',
  await page.evaluate(() => window.__RT2D__.settings.glowRadius === 1050 && window.__RT2D__.settings.directShare === 0.62),
  `glowRadius=${await page.evaluate(() => window.__RT2D__.settings.glowRadius)}`,
);
const restored = await shoot('22-adv-restored');
check('恢复后画面与改动前一致', meanAbsDiff(restored.img, before.img).changedRatio === 0, `差异像素 ${(meanAbsDiff(restored.img, before.img).changedRatio * 100).toFixed(3)}%`);

await page.keyboard.press('KeyA');
await waitFrames(2);
check('再按 A 收起面板', await page.evaluate(() => document.getElementById('advanced').hidden));

await browser.close();
ownServer?.kill();

section('截图');
for (const f of fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).sort()) {
  console.log(`  ${path.join(OUT, f)}  ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1)} kB`);
}

console.log('');
if (fails.length === 0) {
  console.log(`\u001b[32m全部通过\u001b[0m：${pass} 项检查`);
} else {
  console.log(`\u001b[31m失败 ${fails.length} 项\u001b[0m / 共 ${pass + fails.length} 项`);
  for (const f of fails) console.log(`   - ${f}`);
  process.exitCode = 1;
}
