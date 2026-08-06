/**
 * 監理服務網「考照預約報名」查詢的抓取與解析核心。
 *
 * 端點是一個沒有驗證碼、沒有 CSRF token、也不需要登入的純表單 POST：
 *   POST https://www.mvdis.gov.tw/m3-emv-trn/exm/locations
 *   method=query&licenseTypeCode=3&expectExamDateStr=1150810&dmvNoLv1=60&dmvNo=63
 *
 * 回應是整頁 HTML（約 70 KB），我們只要 `id="trnTable"` 那一段（約 15 KB）。
 * 先用 indexOf 切片再跑正則，是為了壓低 Cloudflare Workers 免費方案的
 * 10 ms CPU 上限壓力 —— 不要改成對整頁跑正則。
 */

export const MVDIS_URL = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 額滿的 quota 值。用 -1 而不是 0，才能和「場次存在但真的 0 位」區分。 */
export const FULL = -1;

export type Slot = {
  licenseType: string;
  dmvNo: string;
  /** ISO yyyy-mm-dd */
  examDate: string;
  /** 官網原文，例如 "115年8月17日" */
  rocDate: string;
  /** "星期一" */
  weekday: string;
  isWeekend: boolean;
  /** 同一天可能有多組場次，這是該場次在該日的穩定識別 */
  secKey: string;
  /** 官網 preAdd() 的參數，只有「有位」的列才拿得到 */
  secId: string | null;
  divId: string | null;
  session: string;
  group: number | null;
  /** 餘額；FULL(-1) 代表額滿 */
  quota: number;
  signupAvailable: boolean;
  desc: string;
};

export type QueryInput = {
  licenseType: string;
  lv1: string;
  dmvNo: string;
  /** 民國日期字串 yyyMMdd，預設今天 */
  dateStr?: string;
  onlyWeekend?: boolean;
  signal?: AbortSignal;
};

/** 今天的民國日期字串，例如 2026-08-06 -> "1150806" */
export function rocToday(now: Date = new Date()): string {
  // 監理站是台灣時間，Worker 跑在 UTC，先位移到 UTC+8 再取日期
  const tw = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = tw.getUTCFullYear() - 1911;
  const m = tw.getUTCMonth() + 1;
  const d = tw.getUTCDate();
  return `${String(y).padStart(3, '0')}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

/** "115年8月17日" -> "2026-08-17"；解析不出來回 null */
export function rocDateToIso(roc: string): string | null {
  const m = roc.match(/(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return null;
  const y = Number(m[1]) + 1911;
  return `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function stripHtml(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const SESSION_CODE: Record<string, string> = {
  上午: '1',
  下午: '2',
  晚上: '3',
  夜間: '3',
};

/** 便宜的字串雜湊，只在場次說明無法結構化解析時當作後備鍵 */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * 從場次說明推導出場次鍵。
 *
 * 一定要從說明文字推導，不能只靠 preAdd()：「額滿」的列沒有 preAdd 連結，
 * 若兩種狀態用不同的鍵，同一個場次從「有位」變「額滿」時會被誤判成
 * 一個場次消失＋另一個場次出現，事件流就髒了。
 */
export function deriveSecKey(
  desc: string,
  secId: string | null,
  divId: string | null,
): { secKey: string; session: string; group: number | null } {
  const sm = desc.match(/(上午|下午|晚上|夜間)\s*場次/);
  const gm = desc.match(/組別\s*(\d+)/);
  const session = sm ? sm[1] : '';
  const group = gm ? Number(gm[1]) : null;

  if (session && group !== null) {
    return { secKey: `${SESSION_CODE[session]}:${group}`, session, group };
  }
  if (secId && divId) {
    return { secKey: `${secId}:${divId}`, session, group };
  }
  // 說明文字可能整段改版，退回雜湊；至少同一段文字仍會對應到同一個鍵
  return { secKey: `h:${hash(desc.slice(0, 200))}`, session, group };
}

const TD_RE = /<td[^>]*>([\s\S]*?)<\/td>/g;
const PREADD_RE = /preAdd\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/;

/**
 * 從整頁 HTML 解析出場次清單。
 * 回傳空陣列＝該組合本來就沒有開放場次（很正常，例如恆春分站不考聯結車）。
 */
export function parseSlots(html: string, licenseType: string, dmvNo: string): Slot[] {
  const start = html.indexOf('id="trnTable"');
  if (start < 0) {
    throw new Error('回應中找不到 trnTable，官網結構可能已改版或請求被擋');
  }
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end < 0 ? html.length : end);

  const bodyStart = table.indexOf('<tbody>');
  if (bodyStart < 0) return [];
  const body = table.slice(bodyStart + 7);

  const slots: Slot[] = [];
  for (const chunk of body.split('<tr>').slice(1)) {
    TD_RE.lastIndex = 0;
    const tds: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = TD_RE.exec(chunk)) !== null) tds.push(m[1]);
    if (tds.length < 3) continue;

    const rocDate = stripHtml(tds[0]).replace(/\s+/g, ' ').trim();
    const iso = rocDateToIso(rocDate);
    if (!iso) continue;

    const weekday = (rocDate.match(/星期[一二三四五六日天]/) || [''])[0];
    const desc = stripHtml(tds[1]);

    const quotaText = stripHtml(tds[2]);
    let quota: number;
    if (/額滿/.test(quotaText)) {
      quota = FULL;
    } else {
      const n = quotaText.match(/\d+/);
      if (!n) continue; // 既不是額滿也沒有數字，不是場次列
      quota = Number(n[0]);
    }

    const fn = tds[3] ?? '';
    const pa = fn.match(PREADD_RE);
    const secId = pa ? pa[2] : null;
    const divId = pa ? pa[3] : null;

    const { secKey, session, group } = deriveSecKey(desc, secId, divId);

    slots.push({
      licenseType,
      dmvNo,
      examDate: iso,
      rocDate: rocDate.replace(/\s*\(.*$/, ''),
      weekday,
      isWeekend: weekday === '星期六' || weekday === '星期日' || weekday === '星期天',
      secKey,
      secId,
      divId,
      session,
      group,
      quota,
      signupAvailable: pa !== null,
      desc,
    });
  }
  return slots;
}

/** 查詢單一「照類 × 監理站」組合的所有場次 */
export async function querySlots(input: QueryInput): Promise<Slot[]> {
  const body = new URLSearchParams({
    method: 'query',
    licenseTypeCode: input.licenseType,
    expectExamDateStr: input.dateStr ?? rocToday(),
    _onlyWeekend: 'on',
    dmvNoLv1: input.lv1,
    dmvNo: input.dmvNo,
    secDateStr: '',
    secId: '',
    divId: '',
  });
  if (input.onlyWeekend) body.set('onlyWeekend', 'true');

  const res = await fetch(MVDIS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: MVDIS_URL,
      'Accept-Language': 'zh-TW,zh;q=0.9',
    },
    body,
    signal: input.signal,
  });

  if (!res.ok) {
    throw new Error(`MVDIS 回應 HTTP ${res.status}`);
  }
  return parseSlots(await res.text(), input.licenseType, input.dmvNo);
}

/** 重新抓取某區監理所底下的站別清單，用於官網改制後更新 catalogue.ts */
export async function queryStations(
  lv1: string,
  licenseType = '3',
): Promise<Array<{ no: string; label: string }>> {
  const res = await fetch(MVDIS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: MVDIS_URL,
    },
    body: new URLSearchParams({
      method: 'dmvOnChange',
      licenseTypeCode: licenseType,
      expectExamDateStr: rocToday(),
      _onlyWeekend: 'on',
      dmvNoLv1: lv1,
      dmvNo: '',
    }),
  });
  const html = await res.text();
  const i = html.indexOf('id="dmvNo"');
  if (i < 0) return [];
  const j = html.indexOf('</select>', i);
  const seg = html.slice(i, j < 0 ? html.length : j);
  const out: Array<{ no: string; label: string }> = [];
  for (const m of seg.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)) {
    out.push({ no: m[1], label: m[2] });
  }
  return out;
}

/** 併發上限的 map，用來對政府網站保持禮貌 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
