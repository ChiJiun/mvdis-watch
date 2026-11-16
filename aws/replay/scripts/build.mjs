// 用 esbuild 把 Replay 站打包成單一 ESM 檔 dist/replay.mjs（契約第 2 節）。
// fixture 模板以文字形式嵌進產物，EC2 上只需要這一個檔案。
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/replay.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  loader: { '.html': 'text' },
  legalComments: 'none',
  logLevel: 'info',
});
