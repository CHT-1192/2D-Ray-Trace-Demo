/**
 * 跑 TypeScript 自检：esbuild 打包成临时 ESM 再用 node 执行。
 * 用法：npm test
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = mkdtempSync(path.join(tmpdir(), 'rt2d-test-'));
const outfile = path.join(outdir, 'test.mjs');

await build({
  entryPoints: [path.join(root, 'test/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outfile,
  logLevel: 'warning',
});

const res = spawnSync(process.execPath, [outfile], { stdio: 'inherit' });
process.exit(res.status ?? 1);
