#!/usr/bin/env node
/**
 * 构建：
 *   dist/app.js            站点用的 IIFE bundle（带 sourcemap）
 *   dist/index.html        页面
 *   dist/styles.css        样式
 *   dist/standalone.html   单文件版（CSS/JS 全部内联，file:// 直接双击可用）
 *
 * 参数： --watch | --standalone-only | --quiet
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pub = path.join(root, 'public');
const entry = path.join(root, 'src/app.ts');

const argv = new Set(process.argv.slice(2));
const watch = argv.has('--watch');
const standaloneOnly = argv.has('--standalone-only');
const quiet = argv.has('--quiet');

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

async function bundleSite() {
  const outfile = path.join(dist, 'app.js');
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120', 'edge120', 'firefox121', 'safari17'],
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: true,
    outfile,
    metafile: true,
    logLevel: 'warning',
  });
  return { outfile, bytes: fs.statSync(outfile).size, metafile: result.metafile };
}

async function bundleStandalone() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120', 'edge120', 'firefox121', 'safari17'],
    charset: 'utf8',
    legalComments: 'none',
    minify: true,
    write: false,
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

function inline(html, css, js) {
  const withCss = html.replace(
    /<!-- build:css -->[\s\S]*?<!-- \/build:css -->/,
    `<style>\n${css.trim()}\n</style>`,
  );
  return withCss.replace(/<!-- build:js -->[\s\S]*?<!-- \/build:js -->/, `<script>\n${js.trim()}\n</script>`);
}

function statLines(result) {
  if (!result.metafile || quiet) return;
  const outputs = Object.entries(result.metafile.outputs).filter(([f]) => f.endsWith('.js'));
  for (const [file, meta] of outputs) {
    console.log(`  · ${path.relative(root, file)}  ${kb(meta.bytes)}`);
  }
}

async function buildAll() {
  const t0 = Date.now();
  fs.mkdirSync(dist, { recursive: true });
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');
  fs.writeFileSync(path.join(dist, 'styles.css'), css);
  fs.writeFileSync(path.join(dist, 'index.html'), html);

  let siteInfo = '';
  if (!standaloneOnly) {
    const site = await bundleSite();
    siteInfo = `app.js ${kb(site.bytes)}`;
    if (!quiet) statLines(site);
  }

  const js = await bundleStandalone();
  const standalonePath = path.join(dist, 'standalone.html');
  fs.writeFileSync(standalonePath, inline(html, css, js));

  if (!quiet) {
    const total = fs.statSync(standalonePath).size;
    console.log(
      `\u001b[32m✓\u001b[0m 构建完成 ${Date.now() - t0}ms  ${siteInfo ? `${siteInfo}  ` : ''}standalone.html ${kb(total)}`,
    );
  }
}

if (watch) {
  await buildAll();
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      buildAll().catch((e) => console.error('[build]', e.message));
    }, 120);
  };
  for (const dir of [path.join(root, 'src'), pub]) {
    fs.watch(dir, { recursive: true }, schedule);
  }
  console.log('\u001b[2m[build] 监听 src/ 与 public/ 中…\u001b[0m');
} else {
  await buildAll();
}
