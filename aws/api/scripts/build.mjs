// 打包成單一 ESM 檔 dist/api.mjs（見 aws/CONTRACTS.md 第 2 節），EC2 上不需要 node_modules。
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(root, 'src', 'server.ts')],
  outfile: join(root, 'dist', 'api.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  legalComments: 'none',
  // pg 會 try/catch 地 require 原生驅動 pg-native；我們不用它，也不能在 EC2 上要求編譯
  external: ['pg-native'],
  // pg 與 AWS SDK 是 CommonJS，打成 ESM 時需要一個真的 require 給它們載入 node 內建模組
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
