/**
 * 把政府資料開放平臺「監理機關轄區」資料集併進站別對照表，產生 src/station-info.ts。
 *
 *   npm run stations:info                 下載 CSV、對應 36 站、寫出 src/station-info.ts
 *   npm run stations:info -- --file x.csv 用本機檔案代替下載（離線或官方站台掛掉時）
 *   npm run stations:info -- --dry        只印對應結果，不寫檔
 *
 * 資料集：https://data.gov.tw/dataset/86521（交通部公路局，政府資料開放授權條款-第1版）
 * 欄位：監理所名稱、監理（分）站名稱、地址、電話、傳真、所轄區域
 *
 * 這份資料幾年才改一次，所以刻意做成靜態檔、不進 D1，也不加 cron 去抓——
 * D1 免費方案每次呼叫只有 50 個查詢的額度，留給場次掃描用。
 *
 * 對應規則：CSV 的「監理（分）站名稱」為 `-` 的列是監理所本身，拿「監理所名稱」
 * 去對 catalogue；其餘拿站名對。對不上的兩邊都會印出來，請人工確認後再 commit。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { STATIONS, OFFICE_BY_LV1 } from '../src/catalogue.ts';

const DATASET_ID = '86521';
const DATASET_URL = `https://data.gov.tw/dataset/${DATASET_ID}`;
const LICENSE = '政府資料開放授權條款-第1版';
const LICENSE_URL = 'https://data.gov.tw/license';
const PROVIDER = '交通部公路局';

/**
 * 主要來源是公路局放在交通部網站上的原檔；它偶爾會 502，所以退而求其次用
 * 開放平臺的品質檢測鏡像（同一份檔案，由平臺定期轉存）。
 */
const PRIMARY_URL = 'https://www.motc.gov.tw/uploaddowndoc?file=datagov/1496073019645235200.csv&flag=doc';
const MIRROR_URL = `https://quality.data.gov.tw/dq_download_csv.php?nid=${DATASET_ID}&md5_url=3f8deba3ef87265d00ebaa5e9dbc417d`;

const HEADERS = ['監理所名稱', '監理（分）站名稱', '地址', '電話', '傳真', '所轄區域'];

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '../src/station-info.ts');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);

/* ---------- 下載 ---------- */

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'mvdis-watch stations-info (https://github.com/ChiJiun/mvdis-watch)' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // 502 頁、登入頁之類會回 HTML；CSV 第一列一定是欄位名稱
  if (/^\s*</.test(text) || !text.includes('監理所名稱')) throw new Error('回應不是 CSV');
  return text.replace(/^﻿/, '');
}

async function fetchCsv() {
  const file = opt('--file');
  if (file) return { text: (await readFile(file, 'utf8')).replace(/^﻿/, ''), from: file };
  for (const url of [PRIMARY_URL, MIRROR_URL]) {
    try {
      const text = await download(url);
      return { text, from: url };
    } catch (e) {
      console.warn(`下載失敗 ${url}：${e.message}`);
    }
  }
  throw new Error('兩個來源都抓不到，請從資料集頁面手動下載後用 --file 指定');
}

/** 從資料集頁面抓「詮釋資料更新時間」，抓不到就用今天 */
async function datasetUpdatedAt() {
  try {
    const res = await fetch(DATASET_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const text = html.replace(/<[^>]*>/g, '\n');
    const m = text.match(/詮釋資料更新時間\s*(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  } catch {
    /* 下面退回今天 */
  }
  console.warn('抓不到資料集的更新時間，改記下載日期');
  return null;
}

/* ---------- CSV 解析（RFC 4180，欄位可能含逗號或換行） ---------- */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x !== '')) rows.push(row); }
  return rows;
}

/* ---------- 對應 ---------- */

/** 站名比對用：台/臺互換、去空白、全形括號轉半形 */
const norm = (s) =>
  s.replace(/台/g, '臺').replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').trim();

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

async function main() {
  const { text, from } = await fetchCsv();
  const rows = parseCsv(text);
  const header = rows.shift().map(clean);
  const col = HEADERS.map((h) => header.findIndex((x) => norm(x).startsWith(norm(h))));
  const missing = HEADERS.filter((_, i) => col[i] < 0);
  if (missing.length) throw new Error(`CSV 欄位對不上：缺 ${missing.join('、')}；實際欄位：${header.join(' | ')}`);
  const pick = (r, i) => clean(r[col[i]]);

  const byName = new Map(STATIONS.map((s) => [norm(s.name), s]));
  const info = new Map();
  const unmatchedRows = [];
  for (const r of rows) {
    const office = pick(r, 0);
    const stationName = pick(r, 1);
    const key = norm(stationName === '-' || stationName === '' ? office : stationName);
    const st = byName.get(key);
    const rec = { office, name: stationName, address: pick(r, 2), phone: pick(r, 3), fax: pick(r, 4), area: pick(r, 5) };
    if (!st) { unmatchedRows.push(rec); continue; }
    if (info.has(st.no)) console.warn(`重複對到 ${st.name}（${st.no}）：${office} / ${stationName}`);
    info.set(st.no, { ...rec, station: st });
  }

  /* ---- 報告 ---- */
  console.log(`來源：${from}`);
  console.log(`CSV ${rows.length} 列，對到 ${info.size} / ${STATIONS.length} 站\n`);
  for (const s of STATIONS) {
    const i = info.get(s.no);
    if (!i) continue;
    const addrNote = norm(i.address) === norm(s.address) ? '' : `   地址不同：catalogue「${s.address}」 ↔ CSV「${i.address}」`;
    console.log(`  ${s.no}  ${s.name.padEnd(8, '　')} ${i.phone.padEnd(14)} ${addrNote}`);
  }

  const unmatchedStations = STATIONS.filter((s) => !info.has(s.no));
  if (unmatchedStations.length) {
    console.log(`\n⚠ catalogue 有、CSV 對不到（${unmatchedStations.length}）：`);
    for (const s of unmatchedStations) console.log(`  ${s.no}  ${s.name}  ${OFFICE_BY_LV1.get(s.lv1)?.name ?? ''}`);
  }
  if (unmatchedRows.length) {
    console.log(`\nℹ CSV 有、catalogue 沒有這一站（${unmatchedRows.length}）：`);
    for (const r of unmatchedRows) console.log(`  ${r.office} / ${r.name}  ${r.address}  ${r.phone}`);
  }
  if (!unmatchedStations.length && !unmatchedRows.length) console.log('\n全部對上。');

  if (has('--dry')) return;

  /* ---- 產生 TS ---- */
  const updatedAt = (await datasetUpdatedAt()) ?? new Date().toISOString().slice(0, 10);
  const fetchedAt = new Date().toISOString().slice(0, 10);
  // 單引號字串，跟 catalogue.ts 同一種寫法
  const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const entries = STATIONS.filter((s) => info.has(s.no)).map((s) => {
    const i = info.get(s.no);
    return `  '${s.no}': { phone: ${q(i.phone)}, fax: ${q(i.fax)}, area: ${q(i.area)} }, // ${s.name}`;
  });

  const out = `/**
 * 監理站基本資料：電話、傳真、所轄區域。
 *
 * 由 scripts/stations-info.mjs 自「${PROVIDER}」的開放資料產生，**請勿手改**，
 * 要更新就重跑 \`npm run stations:info\`。靜態寫死而不進 D1，因為這份資料幾年才改一次，
 * 不值得花 D1 免費方案每次呼叫 50 個查詢的額度。
 *
 * 資料集：${DATASET_URL}
 * 授權：${LICENSE}（${LICENSE_URL}）
 */

export type StationInfo = {
  /** 官方寫法，例如 (02)22227835 */
  phone: string;
  fax: string;
  /** 所轄區域原文，含業務範圍說明 */
  area: string;
};

export const STATION_INFO_SOURCE = {
  name: '監理機關轄區',
  provider: ${q(PROVIDER)},
  dataset: ${q(DATASET_URL)},
  license: ${q(LICENSE)},
  licenseUrl: ${q(LICENSE_URL)},
  /** 資料集頁面上的「詮釋資料更新時間」 */
  updatedAt: ${q(updatedAt)},
  /** 本檔產生日 */
  fetchedAt: ${q(fetchedAt)},
} as const;

/** 以 dmvNo 為鍵；對不到開放資料的站不會出現在這裡 */
export const STATION_INFO: Record<string, StationInfo> = {
${entries.join('\n')}
};
`;
  await writeFile(OUT, out, 'utf8');
  console.log(`\n已寫入 ${path.relative(process.cwd(), OUT)}（${entries.length} 站，資料集更新 ${updatedAt}）`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
