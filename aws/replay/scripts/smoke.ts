/**
 * 打包產物的冒煙測試：啟動 dist/replay.mjs，用和原型 querySlots 相同的表單
 * 把 360 組全部打一次，每一頁都用原型 parseSlots 解析，最後關掉服務。
 *
 *   npm run build && npm run smoke
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSlots, rocToday } from '../../../src/mvdis.ts';
import { allCombos } from '../../../src/catalogue.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.SMOKE_PORT ?? '18080';
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [join(HERE, '..', 'dist', 'replay.mjs')], {
  env: { ...process.env, PORT, REPLAY_DELAY_MS: '0', REPLAY_JITTER_MS: '0', REPLAY_FLIP_PROB: '0.05' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
child.stdout.on('data', (d) => process.stdout.write(`[replay] ${d}`));

async function waitHealthy() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('replay 沒有在 5 秒內起來');
}

try {
  await waitHealthy();
  const t0 = Date.now();
  let rows = 0;
  let available = 0;
  let empty = 0;
  for (const c of allCombos()) {
    const res = await fetch(`${BASE}/m3-emv-trn/exm/locations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        method: 'query',
        licenseTypeCode: c.licenseType,
        expectExamDateStr: rocToday(),
        _onlyWeekend: 'on',
        dmvNoLv1: c.lv1,
        dmvNo: c.dmvNo,
        secDateStr: '',
        secId: '',
        divId: '',
      }),
    });
    if (!res.ok) throw new Error(`${c.licenseType}|${c.dmvNo} HTTP ${res.status}`);
    const slots = parseSlots(await res.text(), c.licenseType, c.dmvNo);
    rows += slots.length;
    available += slots.filter((s) => s.quota > 0).length;
    if (slots.length === 0) empty++;
  }
  const stats = (await (await fetch(`${BASE}/admin/stats`)).json()) as { requests: number; released: number };
  console.log(
    `PASS 360 組全部解析成功：${rows} 列（有位 ${available}）、空組合 ${empty}、耗時 ${Date.now() - t0} ms；` +
      `replay 計數 requests=${stats.requests} released=${stats.released}`,
  );
  if (stats.requests !== 360) throw new Error(`requests 計數 ${stats.requests} ≠ 360`);
} catch (e) {
  console.error('FAIL', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM');
}
