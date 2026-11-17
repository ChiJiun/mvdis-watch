// 把原型的前端靜態檔（根目錄 public/）內嵌成 src/static.gen.ts。
// EC2 上只會下載單一個 dist/api.mjs，所以靜態檔必須打包進去；public/ 是原型的檔案，這裡只讀不改。
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', '..', '..', 'public');
const outFile = join(here, '..', 'src', 'static.gen.ts');

const FILES = {
  'index.html': 'text/html; charset=utf-8',
  'station.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'station.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'aura.js': 'text/javascript; charset=utf-8',
  // 儀表板頂部背景用的 shaders 套件（同源托管，不從第三方 CDN 載入；授權見 LICENSE 檔）
  'vendor/shaders-4.0.7.js': 'text/javascript; charset=utf-8',
  'vendor/shaders-4.0.7.LICENSE.txt': 'text/plain; charset=utf-8',
};

const entries = Object.entries(FILES).map(([name, type]) => {
  const body = readFileSync(join(publicDir, name), 'utf8');
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  return `  ${JSON.stringify(name)}: { type: ${JSON.stringify(type)}, etag: ${JSON.stringify(etag)}, body: ${JSON.stringify(body)} },`;
});

const src = `// 由 scripts/gen-static.mjs 從根目錄 public/ 產生，不要手改，也不要進版控。
export type StaticFile = { type: string; etag: string; body: string };
export const STATIC: Record<string, StaticFile> = {
${entries.join('\n')}
};
`;
writeFileSync(outFile, src);
