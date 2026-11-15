/**
 * 從監理服務網抓少量真實頁面，當 Replay 模擬站的 HTML 模板。
 *
 *   node --experimental-strip-types scripts/capture-fixtures.ts --dry-run   只印出會抓哪些，不連網
 *   node --experimental-strip-types scripts/capture-fixtures.ts             抓預設的 4 頁
 *   node --experimental-strip-types scripts/capture-fixtures.ts --only full 只抓某一頁
 *
 * 禮貌限制（硬性，寫死在程式裡）：
 *   - 兩次請求至少間隔 5 秒（跨次執行也算，依 capture-budget.json 的 lastAt）
 *   - 整個開發期間總共最多 40 次，用 fixtures/capture-budget.json 記帳並 commit 進 repo
 *
 * 為什麼只抓 4 頁：模擬站要的是「HTML 長什麼樣子」，不是 360 組的真實餘額。
 * 有位／全額滿／沒有場次／汽車照類各一頁就涵蓋了 parseSlots 會遇到的所有列型態，
 * 360 組的變化由 src/generator.ts 用程式產生。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MVDIS_URL, parseSlots, rocToday } from '../../../src/mvdis.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'fixtures');
const RAW_DIR = join(FIXTURE_DIR, 'raw');
const BUDGET_FILE = join(FIXTURE_DIR, 'capture-budget.json');

export const BUDGET_LIMIT = 40;
export const MIN_GAP_MS = 5_000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

type Target = { name: string; licenseType: string; lv1: string; dmvNo: string; note: string };

const TARGETS: Target[] = [
  { name: 'available', licenseType: '3', lv1: '60', dmvNo: '63', note: '豐原站普通重型機車（原型實測常有位）' },
  { name: 'full', licenseType: '3', lv1: '40', dmvNo: '41', note: '板橋站普通重型機車（原型實測常全額滿）' },
  { name: 'empty', licenseType: 'H', lv1: '80', dmvNo: '83', note: '恆春分站職業聯結車（預期無場次）' },
  { name: 'car', licenseType: 'A', lv1: '70', dmvNo: '74', note: '臺南站普通小型車（汽車照類的列格式）' },
];

type Budget = { limit: number; used: number; lastAt: number | null; log: Array<{ at: string; name: string; status: number | string }> };

async function loadBudget(): Promise<Budget> {
  try {
    return JSON.parse(await readFile(BUDGET_FILE, 'utf8')) as Budget;
  } catch {
    return { limit: BUDGET_LIMIT, used: 0, lastAt: null, log: [] };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const targets = only ? TARGETS.filter((t) => t.name === only) : TARGETS;
  if (targets.length === 0) throw new Error(`沒有名為 ${only} 的目標；可選：${TARGETS.map((t) => t.name).join(', ')}`);

  const budget = await loadBudget();
  const remaining = Math.min(BUDGET_LIMIT, budget.limit) - budget.used;
  console.log(`請求預算：已用 ${budget.used} / ${BUDGET_LIMIT}，這次要抓 ${targets.length} 頁`);
  if (targets.length > remaining) {
    throw new Error(`預算不足：剩 ${remaining} 次，這次需要 ${targets.length} 次。不要調高上限。`);
  }
  const dateStr = rocToday();
  if (dry) {
    for (const t of targets) console.log(`[dry-run] ${t.name}: ${t.note} licenseType=${t.licenseType} dmvNo=${t.dmvNo} date=${dateStr}`);
    return;
  }

  await mkdir(RAW_DIR, { recursive: true });
  const indexFile = join(RAW_DIR, 'index.json');
  let index: Record<string, unknown> = {};
  try {
    index = JSON.parse(await readFile(indexFile, 'utf8'));
  } catch {}

  for (const t of targets) {
    const wait = budget.lastAt ? budget.lastAt + MIN_GAP_MS - Date.now() : 0;
    if (wait > 0) await sleep(wait);

    // 先記帳再送出：就算請求失敗或程式中斷，這一次也算數
    budget.used += 1;
    budget.lastAt = Date.now();
    const entry = { at: new Date(budget.lastAt).toISOString(), name: t.name, status: 'pending' as number | string };
    budget.log.push(entry);
    await writeFile(BUDGET_FILE, JSON.stringify(budget, null, 2) + '\n');

    const form = {
      method: 'query',
      licenseTypeCode: t.licenseType,
      expectExamDateStr: dateStr,
      _onlyWeekend: 'on',
      dmvNoLv1: t.lv1,
      dmvNo: t.dmvNo,
      secDateStr: '',
      secId: '',
      divId: '',
    };
    let status: number | string;
    try {
      const res = await fetch(MVDIS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          Referer: MVDIS_URL,
          'Accept-Language': 'zh-TW,zh;q=0.9',
        },
        body: new URLSearchParams(form),
      });
      status = res.status;
      const html = await res.text();
      const file = `${t.name}.html`;
      await writeFile(join(RAW_DIR, file), html);
      let parsed: { rows: number; available: number; full: number } | { error: string };
      try {
        const slots = parseSlots(html, t.licenseType, t.dmvNo);
        parsed = { rows: slots.length, available: slots.filter((s) => s.quota > 0).length, full: slots.filter((s) => s.quota < 0).length };
      } catch (e) {
        parsed = { error: String(e) };
      }
      index[t.name] = { ...t, file, form, capturedAt: entry.at, httpStatus: res.status, bytes: html.length, parsed };
      console.log(`${t.name}: HTTP ${res.status}，${html.length} 字元，解析結果 ${JSON.stringify(parsed)}`);
    } catch (e) {
      status = `error: ${String(e)}`;
      console.log(`${t.name}: 失敗 ${String(e)}`);
    }
    entry.status = status;
    await writeFile(BUDGET_FILE, JSON.stringify(budget, null, 2) + '\n');
    await writeFile(indexFile, JSON.stringify(index, null, 2) + '\n');
  }
  console.log(`完成。預算已用 ${budget.used} / ${BUDGET_LIMIT}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
