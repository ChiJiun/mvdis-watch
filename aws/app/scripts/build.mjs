/**
 * 打包出契約第 2 節規定的三個產物：
 *   dist/dispatcher.zip（內含 index.mjs，handler = index.handler）
 *   dist/notifier.zip  （同上）
 *   dist/janitor.zip   （同上）
 *   dist/worker.mjs    （EC2 上以 systemd 執行）
 *
 * AWS SDK 一律打包進去，不依賴 Lambda runtime 內建的版本。
 */
import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// 打包進 ESM 的 CommonJS 套件（pg、AWS SDK 的部分相依）會呼叫 require()
const banner = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  // pg 只有在使用 native binding 時才 require('pg-native')
  external: ['pg-native'],
  logLevel: 'warning',
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const name of ['dispatcher', 'notifier', 'janitor']) {
  const out = join(dist, name, 'index.mjs');
  await build({ ...common, entryPoints: [join(root, 'src', name, 'index.ts')], outfile: out });
  const code = await readFile(out);
  await writeFile(join(dist, `${name}.zip`), zip([{ name: 'index.mjs', data: code }]));
  await rm(join(dist, name), { recursive: true, force: true });
  console.log(`dist/${name}.zip  (index.mjs ${(code.length / 1024).toFixed(0)} KB)`);
}

await build({ ...common, entryPoints: [join(root, 'src', 'worker', 'main.ts')], outfile: join(dist, 'worker.mjs') });
const w = await readFile(join(dist, 'worker.mjs'));
console.log(`dist/worker.mjs  (${(w.length / 1024).toFixed(0)} KB)`);
