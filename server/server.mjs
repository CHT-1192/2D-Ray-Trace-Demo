#!/usr/bin/env node
/**
 * 零依赖静态服务器：把 dist/ 跑起来。
 *
 *   node server/server.mjs                  默认 http://127.0.0.1:6850
 *   node server/server.mjs --port 8080
 *   node server/server.mjs --watch          监视 src/public，改动自动重建 + 页面自动刷新
 *   node server/server.mjs --open           启动后打开浏览器
 *
 * dist/ 不存在时会自动先构建一次。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const watch = has('--watch');
const open = has('--open');
const startPort = Number(process.env.PORT || valueOf('--port', '6850'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const LIVERELOAD = `
<script>
(() => {
  let token = null;
  const tick = async () => {
    try {
      const r = await fetch('/__build', { cache: 'no-store' });
      const next = await r.text();
      if (token !== null && next !== token) location.reload();
      token = next;
    } catch {}
  };
  setInterval(tick, 700);
  tick();
})();
</script>
`;

function ensureBuilt() {
  if (fs.existsSync(path.join(dist, 'index.html'))) return;

  // 刚 clone 下来时 dist/index.html 是没有的（只提交了单文件版），需要现构建一次。
  // 但构建要用 esbuild，所以先确认依赖装了没有，免得抛一个看不懂的 MODULE_NOT_FOUND。
  if (!fs.existsSync(path.join(root, 'node_modules', 'esbuild'))) {
    console.error('\n  \u001b[31m还没装依赖\u001b[0m：dist/index.html 需要现构建，而 esbuild 不在 node_modules 里。');
    console.error('  请先执行：\u001b[1mnpm install && npm run build\u001b[0m');
    console.error('  \u001b[2m（只想看效果的话，直接用浏览器打开 dist/standalone.html 也行，它不需要构建）\u001b[0m\n');
    process.exit(1);
  }

  console.log('[server] 首次运行，先构建一次…');
  const res = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function buildToken() {
  try {
    const files = ['app.js', 'index.html', 'styles.css', 'standalone.html'];
    return files.map((f) => fs.statSync(path.join(dist, f)).mtimeMs).join('-');
  } catch {
    return '0';
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const file = path.resolve(dist, rel);
  if (!file.startsWith(dist)) return null; // 目录穿越防护
  return file;
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (url.startsWith('/__build')) {
    return send(res, 200, buildToken(), { 'content-type': 'text/plain' });
  }

  let file = resolveFile(url);
  if (!file) return send(res, 403, 'forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return send(res, 404, 'not found');

  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';

  if (watch && ext === '.html') {
    let body = fs.readFileSync(file, 'utf8');
    body = body.replace('</body>', `${LIVERELOAD}</body>`);
    return send(res, 200, body, { 'content-type': type });
  }

  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

function listen(port, attempt = 0) {
  // 每次尝试都要把自己注册的监听摘干净：失败重试时如果留着上一次的
  // 'listening' 回调，最后成功那一刻会把历次端口都打印一遍（误导人的横幅）。
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && attempt < 12) {
      listen(port + 1, attempt + 1);
      return;
    }
    console.error('[server]', err.message);
    process.exit(1);
  };

  const onListening = () => {
    server.removeListener('error', onError);
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\n  \u001b[1m2D 光线追踪 Demo\u001b[0m  \u001b[36m${url}\u001b[0m`);
    console.log(`  \u001b[2m单文件版: ${url}standalone.html\u001b[0m`);
    if (watch) console.log('  \u001b[2m监听模式：改动 src/ 会自动重建并刷新页面\u001b[0m');
    if (attempt > 0) console.log(`  \u001b[2m（${startPort} 起的前 ${attempt} 个端口被占用，自动顺延到这里）\u001b[0m`);
    console.log('');
    if (open && process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' });
    if (open && process.platform !== 'darwin') spawn('xdg-open', [url], { stdio: 'ignore' });
  };

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}

ensureBuilt();

let watcher = null;
if (watch) {
  watcher = spawn(process.execPath, [path.join(root, 'scripts/build.mjs'), '--watch'], { stdio: 'inherit' });
}

listen(startPort);

const shutdown = () => {
  watcher?.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 200);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
