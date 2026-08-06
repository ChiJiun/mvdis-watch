/**
 * 本機驗證用：直接跑抓取核心，不碰 Cloudflare。
 *
 *   npm run sweep -- --fixtures   針對已知組合做解析正確性檢查
 *   npm run sweep                 全 360 組合掃一輪並印統計
 *   npm run sweep -- --hot        只掃熱門層（機車 + 普通小型車，108 組）
 *   npm run sweep -- --stations   重新抓站別清單（官網改制時用）
 */
import { allCombos, hotCombos, STATION_BY_NO, LICENSE_BY_CODE, OFFICES } from '../src/catalogue.ts';
import { querySlots, queryStations, mapLimit, FULL } from '../src/mvdis.ts';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const label = (c) =>
  `${LICENSE_BY_CODE.get(c.licenseType)?.name ?? c.licenseType} @ ${STATION_BY_NO.get(c.dmvNo)?.name ?? c.dmvNo}`;

async function stations() {
  for (const o of OFFICES) {
    const list = await queryStations(o.lv1);
    console.log(`\n# ${o.lv1} ${o.name}  (${list.length} 站)`);
    for (const s of list) console.log(`  ${s.no}\t${s.label}`);
  }
}

/**
 * 解析正確性檢查。
 * 這些期望值來自規劃階段對官網的實測，但餘額本來就會隨時間變動，
 * 所以只斷言「結構」而不是「數字」：有位的站要解析得出 preAdd 連結與正整數餘額，
 * 全額滿的站要每一列都是 FULL，而且任何一列都必須有可用的 secKey。
 */
async function fixtures() {
  const cases = [
    { licenseType: '3', lv1: '60', dmvNo: '63', note: '豐原站重機（實測有位）' },
    { licenseType: '3', lv1: '70', dmvNo: '74', note: '臺南站重機（實測有位）' },
    { licenseType: '3', lv1: '40', dmvNo: '41', note: '板橋站重機（實測全額滿）' },
    { licenseType: 'H', lv1: '80', dmvNo: '83', note: '恆春分站職業聯結車（預期無場次）' },
  ];

  let failed = 0;
  for (const c of cases) {
    const slots = await querySlots(c);
    const avail = slots.filter((s) => s.quota > 0);
    const full = slots.filter((s) => s.quota === FULL);
    const keys = new Set(slots.map((s) => `${s.examDate}|${s.secKey}`));

    const problems = [];
    if (keys.size !== slots.length) problems.push(`secKey 撞鍵：${slots.length} 列只產生 ${keys.size} 個鍵`);
    for (const s of slots) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s.examDate)) problems.push(`日期解析失敗：${s.rocDate}`);
      if (s.quota > 0 && !s.signupAvailable) problems.push(`有餘額卻沒有報名連結：${s.examDate} ${s.secKey}`);
      if (s.quota === FULL && s.signupAvailable) problems.push(`額滿卻有報名連結：${s.examDate} ${s.secKey}`);
      if (s.secKey.startsWith('h:')) problems.push(`場次說明無法結構化解析，退回雜湊鍵：${s.desc.slice(0, 40)}`);
    }

    const ok = problems.length === 0;
    if (!ok) failed++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${c.note}\n      ${slots.length} 列（有位 ${avail.length} / 額滿 ${full.length}）`,
    );
    if (avail.length) {
      const s = avail[0];
      console.log(`      範例：${s.examDate} ${s.weekday} ${s.session}場次 組別${s.group} 餘額 ${s.quota}`);
    }
    for (const p of problems) console.log(`      ! ${p}`);
  }
  console.log(failed === 0 ? '\n全部通過' : `\n${failed} 個組合有問題`);
  process.exitCode = failed === 0 ? 0 : 1;
}

async function sweep(combos) {
  const t0 = Date.now();
  let errors = 0;
  let emptyCombos = 0;
  let rows = 0;
  const available = [];
  const badKeys = [];

  await mapLimit(combos, 5, async (c) => {
    try {
      const slots = await querySlots(c);
      rows += slots.length;
      if (!slots.length) emptyCombos++;
      const keys = new Set(slots.map((s) => `${s.examDate}|${s.secKey}`));
      if (keys.size !== slots.length) badKeys.push(label(c));
      for (const s of slots) if (s.quota > 0) available.push({ c, s });
    } catch (e) {
      errors++;
      console.log(`  ERROR ${label(c)}: ${e.message}`);
    }
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n掃描 ${combos.length} 組合，耗時 ${secs}s，失敗 ${errors}`);
  console.log(`場次列 ${rows} 筆，其中無場次的組合 ${emptyCombos} 個`);
  console.log(`目前有餘額的場次：${available.length} 筆`);
  if (badKeys.length) console.log(`secKey 撞鍵的組合：${badKeys.join(', ')}`);

  available.sort((a, b) => b.s.quota - a.s.quota);
  for (const { c, s } of available.slice(0, 20)) {
    console.log(`  ${String(s.quota).padStart(3)} 位  ${s.examDate} ${s.weekday}  ${label(c)}  ${s.session}場次 組別${s.group}`);
  }
  if (available.length > 20) console.log(`  ...另外 ${available.length - 20} 筆`);
}

if (has('--stations')) await stations();
else if (has('--fixtures')) await fixtures();
else await sweep(has('--hot') ? hotCombos() : allCombos());
