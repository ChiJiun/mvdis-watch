/**
 * 從原型 src/catalogue.ts 產生 common/combos.json，給 Python 實驗腳本用。
 *
 *   node --experimental-strip-types common/gen_combos.ts          重新產生
 *   node --experimental-strip-types common/gen_combos.ts --check  只檢查 combos.json 是否和 catalogue 同步
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LICENSE_TYPES, STATIONS, allCombos, LICENSE_BY_CODE } from '../../../src/catalogue.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), 'combos.json');
const data = {
  generatedFrom: 'src/catalogue.ts',
  licenseTypes: LICENSE_TYPES.map((t) => ({ code: t.code, name: t.name, hot: t.hot })),
  stations: STATIONS.map((s) => ({ no: s.no, lv1: s.lv1, name: s.name })),
  combos: allCombos().map((c) => ({ ...c, hot: LICENSE_BY_CODE.get(c.licenseType)!.hot })),
};
const text = JSON.stringify(data, null, 1) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
  } catch {}
  if (current !== text) {
    console.error('combos.json 和 src/catalogue.ts 不同步，請重新執行 gen_combos.ts');
    process.exit(1);
  }
  console.log(`combos.json 同步（${data.combos.length} 組）`);
} else {
  writeFileSync(out, text);
  console.log(`已寫入 ${out}（${data.combos.length} 組）`);
}
