/**
 * Replay 模擬站的資料模型與 HTML 產生器（純函式＋狀態物件，不碰網路）。
 *
 * 模板來源：fixtures/raw/*.html 是 2026-11 從官網抓的 4 頁真實頁面。
 * 我們只借用頁面外殼（`<tbody>` 之前與 `</tbody>` 之後），表格列由 renderRow()
 * 依真實頁面的列格式（含空白與縮排）重新產生，這樣 360 組可以有各自的場次與名額，
 * 又保證和官網同格式、能被原型 `src/mvdis.ts` 的 parseSlots 解析。
 */
import { LICENSE_TYPES, STATIONS, STATION_BY_NO, type Station } from '../../../src/catalogue.ts';

// ───────────── 決定性亂數 ─────────────

/** 32-bit 字串雜湊（FNV-1a），拿來當每個組合的子種子 */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32：小而夠用的可重現亂數產生器，回傳 [0, 1) */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// ───────────── 模板 ─────────────

export type PageTemplate = {
  /** 整頁 HTML 到 `<tbody>`（含）為止 */
  head: string;
  /** 從 `</tbody>` 開始到頁尾 */
  tail: string;
};

/** 把真實頁面切成外殼。找不到 trnTable 代表模板壞了，直接丟錯，不要默默產出壞頁面 */
export function splitTemplate(html: string): PageTemplate {
  const t = html.indexOf('id="trnTable"');
  if (t < 0) throw new Error('模板裡找不到 trnTable');
  const b = html.indexOf('<tbody>', t);
  const e = html.indexOf('</tbody>', t);
  if (b < 0 || e < 0 || e < b) throw new Error('模板的 trnTable 沒有完整的 <tbody>');
  return { head: html.slice(0, b + '<tbody>'.length), tail: html.slice(e) };
}

// ───────────── 場次模型 ─────────────

export type SessionName = '上午' | '下午';
const SESSION_CODE: Record<SessionName, string> = { 上午: '1', 下午: '2' };
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export type SlotState = {
  /** ISO yyyy-mm-dd */
  examDate: string;
  /** "115年11月19日" */
  rocDate: string;
  weekday: string;
  session: SessionName;
  group: number;
  /** 和 parseSlots 推導出的 secKey 相同，例如 "2:25" */
  secKey: string;
  /** 場次說明的第二行起（可含 <br>、<font>） */
  note: string;
  /** 有位時的上限，擾動成有位時從 1..capacity 取值 */
  capacity: number;
  /** -1 = 額滿 */
  quota: number;
};

export type ComboState = {
  licenseType: string;
  lv1: string;
  dmvNo: string;
  slots: SlotState[];
};

export const comboKey = (licenseType: string, dmvNo: string) => `${licenseType}|${dmvNo}`;

/** 場次說明文字，取自真實頁面（機車／普小），其餘照類套用同樣句型 */
function noteFor(licenseType: string, session: SessionName, variant: number): string {
  if (licenseType === '3' || licenseType === '5') {
    return variant % 2 === 0
      ? `請提前做好體檢(勿當日才體檢)，並於${session}${session === '上午' ? '08:30' : '13:00'}準時攜帶體檢表.身分證.照片至3樓報到<br><font color="blue" size="5">本場次僅供第一次報考者預約</font>`
      : `需攜帶體檢表.身分證.照片<br><font color="red" size="5">本場次僅供重考生、持有輕機駕照者或已上過初考領講習(未超過1年)者預約，至3樓報名時間${session === '上午' ? '08:30' : '13:00'}</font>`;
  }
  const label = licenseType === 'A' ? '普小' : licenseType === 'B' ? '職小' : '';
  const window = session === '上午' ? '上午8點半至9點' : '下午1點半至2點';
  return `報考${label}請備妥體檢表、身分證、相片(含體檢需3張)、學習駕照，於${window}前完成報到及繳費`;
}

/** 民國日期字串（"115年11月19日"）與 ISO 日期 */
function dayInfo(d: Date): { iso: string; roc: string; weekday: string } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    iso: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    roc: `${y - 1911}年${m}月${day}日`,
    weekday: WEEKDAYS[d.getUTCDay()],
  };
}

export type GenOptions = {
  seed: number;
  /** 產生場次的起算時間（epoch ms）；考試日期從台灣時間的「今天＋3 天」開始 */
  now: number;
  /** 往後產生幾天的場次，預設 30 */
  horizonDays?: number;
  /** 初始為額滿的比例，預設 0.7（熱門站常態是大多額滿） */
  fullRatio?: number;
};

const HOT = new Set(LICENSE_TYPES.filter((t) => t.hot).map((t) => t.code));

/**
 * 為單一組合產生場次。同一個 seed＋組合永遠得到相同結果（/admin/reset 靠這個還原）。
 * 熱門照類 5% 機率整組沒有場次、冷門照類 35%，模擬「恆春分站不考聯結車」這類常態。
 */
export function generateCombo(licenseType: string, station: Station, opts: GenOptions): ComboState {
  const rng = mulberry32(hashStr(`${opts.seed}|${licenseType}|${station.no}`));
  const horizon = opts.horizonDays ?? 30;
  const fullRatio = opts.fullRatio ?? 0.7;
  const combo: ComboState = { licenseType, lv1: station.lv1, dmvNo: station.no, slots: [] };

  const emptyProb = HOT.has(licenseType) ? 0.05 : 0.35;
  if (rng() < emptyProb) return combo;

  // 每個組合固定 1–3 條「場次軌」（上午/下午 × 組別），每個考試日都開
  const trackCount = randInt(rng, 1, 3);
  const tracks: Array<{ session: SessionName; group: number; note: string; capacity: number }> = [];
  const used = new Set<string>();
  for (let i = 0; i < trackCount; i++) {
    const session: SessionName = rng() < 0.5 ? '上午' : '下午';
    let group = randInt(rng, 1, 40);
    while (used.has(`${session}:${group}`)) group = (group % 40) + 1;
    used.add(`${session}:${group}`);
    tracks.push({ session, group, note: noteFor(licenseType, session, i), capacity: randInt(rng, 3, 30) });
  }
  const saturday = rng() < 0.15;

  // 台灣時間的今天
  const tw = new Date(opts.now + 8 * 3600 * 1000);
  const today = Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate());
  for (let i = 3; i < 3 + horizon; i++) {
    const d = new Date(today + i * 86_400_000);
    const dow = d.getUTCDay();
    if (dow === 0 || (dow === 6 && !saturday)) continue;
    const info = dayInfo(d);
    for (const t of tracks) {
      if (rng() < 0.15) continue; // 偶爾某天沒開這條軌
      combo.slots.push({
        examDate: info.iso,
        rocDate: info.roc,
        weekday: info.weekday,
        session: t.session,
        group: t.group,
        secKey: `${SESSION_CODE[t.session]}:${t.group}`,
        note: t.note,
        capacity: t.capacity,
        quota: rng() < fullRatio ? -1 : randInt(rng, 1, t.capacity),
      });
    }
  }
  // 官網依日期、再依場次排序
  combo.slots.sort((a, b) => (a.examDate < b.examDate ? -1 : a.examDate > b.examDate ? 1 : a.secKey < b.secKey ? -1 : 1));
  return combo;
}

// ───────────── HTML ─────────────

/** 官網頁面一律是 CRLF 換行 */
const NL = '\r\n';
const T = (n: number) => '\t'.repeat(n);

/** 依真實頁面的列格式產生一列（換行、縮排、屬性與官網一致） */
export function renderRow(s: SlotState): string {
  const quotaCell =
    s.quota < 0
      ? `${NL}${T(7)}${NL}${T(8)}${NL}${T(9)}額滿${NL}${T(8)}${NL}${T(8)}${NL}${T(7)}${NL}${T(6)}`
      : `${NL}${T(7)}${NL}${T(8)}${NL}${T(8)}${NL}${T(9)}${s.quota}${NL}${T(8)}${NL}${T(7)}${NL}${T(6)}`;
  const fnCell =
    s.quota < 0
      ? `${NL}${T(7)}${NL}${T(8)}${NL}${T(8)}${NL}${T(8)}${NL}${T(7)}${NL}${T(6)}`
      : `${NL}${T(7)}${NL}${T(8)}${NL}${T(8)}${NL}${T(9)}<a href="#" class="std_btn"${NL}${T(12)}onclick="preAdd('${s.examDate}', '${SESSION_CODE[s.session]}', '${s.group}')">${NL}${T(12)}報名 SignUp</a>${NL}${T(8)}${NL}${T(7)}${NL}${T(6)}`;
  return (
    `<tr>${NL}` +
    `${T(6)}<td class="align_c">${NL}${T(7)}${s.rocDate} (${s.weekday})${NL}${T(6)}</td>${NL}` +
    `${T(6)}<td class="align_c">${NL}${T(7)} ${NL}${T(7)}${NL}${T(7)}${s.session}場次, 組別 ${s.group}${NL}${T(7)}<br>${NL}${T(7)}${s.note}${NL}${T(6)}</td>${NL}` +
    `${T(6)}<td class="align_c">${quotaCell}</td>${NL}` +
    `${T(6)}<td class="align_c">${fnCell}</td>${NL}` +
    `${T(5)}</tr>`
  );
}

/** 列與列之間（以及 <tbody> 後第一列之前）的空白，和官網 JSP 迴圈留下的一樣 */
const ROW_SEP = `${NL}${T(4)}${NL}${T(5)}${NL}${T(5)}${NL}${T(5)}`;
/** 最後一列之後到 </tbody>；空表格也是這段 */
const BODY_END = `${NL}${T(4)}${NL}${T(3)}`;

export function renderPage(tpl: PageTemplate, slots: SlotState[]): string {
  if (slots.length === 0) return tpl.head + BODY_END + tpl.tail;
  return tpl.head + ROW_SEP + slots.map(renderRow).join(ROW_SEP) + BODY_END + tpl.tail;
}

// ───────────── 執行期狀態與擾動 ─────────────

export type FlipEvent = {
  /** 遞增序號，/admin/events?after= 用它分頁 */
  seq: number;
  at: number;
  licenseType: string;
  dmvNo: string;
  examDate: string;
  secKey: string;
  /** released = 額滿→有位（釋位），filled = 有位→額滿 */
  kind: 'released' | 'filled';
  oldQuota: number;
  newQuota: number;
  cause: 'request' | 'clock';
};

export type ReplayConfig = {
  seed: number;
  /** 每次請求時，該組合每個場次翻轉（額滿↔有位）的機率 */
  flipProb: number;
  /** clock 模式：每隔 tickMs 從全部場次隨機挑 flipsPerTick 個翻轉；0 = 關閉 */
  tickMs: number;
  flipsPerTick: number;
  fullRatio: number;
  horizonDays: number;
  /** 事件環形緩衝的上限 */
  maxEvents: number;
};

export const DEFAULT_CONFIG: ReplayConfig = {
  seed: 20261116,
  flipProb: 0.02,
  tickMs: 0,
  flipsPerTick: 5,
  fullRatio: 0.7,
  horizonDays: 30,
  maxEvents: 100_000,
};

export class ReplayState {
  readonly combos = new Map<string, ComboState>();
  events: FlipEvent[] = [];
  private seq = 0;
  private rng: Rng;
  requests = 0;
  resetAt: number;
  /** 所有場次的扁平索引，clock 模式抽樣用 */
  private allSlots: Array<{ combo: ComboState; slot: SlotState }> = [];

  config: ReplayConfig;

  // 不用 parameter property：node --experimental-strip-types 不支援
  constructor(config: ReplayConfig, now: number = Date.now()) {
    this.config = config;
    this.rng = mulberry32(config.seed ^ 0x9e3779b9);
    this.resetAt = now;
    this.build(now);
  }

  private build(now: number) {
    this.combos.clear();
    this.allSlots = [];
    for (const t of LICENSE_TYPES) {
      for (const s of STATIONS) {
        const c = generateCombo(t.code, s, {
          seed: this.config.seed,
          now,
          horizonDays: this.config.horizonDays,
          fullRatio: this.config.fullRatio,
        });
        this.combos.set(comboKey(t.code, s.no), c);
        for (const slot of c.slots) this.allSlots.push({ combo: c, slot });
      }
    }
  }

  /** 還原成 seed 決定的初始狀態；可同時換參數 */
  reset(patch: Partial<ReplayConfig> = {}, now: number = Date.now()) {
    this.config = { ...this.config, ...patch };
    this.rng = mulberry32(this.config.seed ^ 0x9e3779b9);
    this.events = [];
    this.seq = 0;
    this.requests = 0;
    this.resetAt = now;
    this.build(now);
  }

  /** 查詢一個組合；lv1 對不上或組合不存在時回 null（頁面照樣回，只是表格是空的） */
  lookup(licenseType: string, lv1: string, dmvNo: string): ComboState | null {
    const station = STATION_BY_NO.get(dmvNo);
    if (!station || station.lv1 !== lv1) return null;
    return this.combos.get(comboKey(licenseType, dmvNo)) ?? null;
  }

  private flip(combo: ComboState, slot: SlotState, at: number, cause: FlipEvent['cause']) {
    const oldQuota = slot.quota;
    const kind: FlipEvent['kind'] = oldQuota < 0 ? 'released' : 'filled';
    slot.quota = kind === 'released' ? randInt(this.rng, 1, Math.min(3, slot.capacity)) : -1;
    this.events.push({
      seq: ++this.seq,
      at,
      licenseType: combo.licenseType,
      dmvNo: combo.dmvNo,
      examDate: slot.examDate,
      secKey: slot.secKey,
      kind,
      oldQuota,
      newQuota: slot.quota,
      cause,
    });
    if (this.events.length > this.config.maxEvents) {
      this.events.splice(0, this.events.length - this.config.maxEvents);
    }
  }

  /** 請求觸發的擾動：在回應「之前」翻轉，所以這次回應就看得到 */
  perturbOnRequest(combo: ComboState, at: number) {
    const p = this.config.flipProb;
    if (p <= 0) return;
    for (const slot of combo.slots) if (this.rng() < p) this.flip(combo, slot, at, 'request');
  }

  /** clock 模式的一拍：和請求無關，用來量「釋位發生 → 被偵測到」的延遲 */
  tick(at: number) {
    if (this.allSlots.length === 0) return;
    for (let i = 0; i < this.config.flipsPerTick; i++) {
      const pick = this.allSlots[Math.floor(this.rng() * this.allSlots.length)];
      this.flip(pick.combo, pick.slot, at, 'clock');
    }
  }

  eventsAfter(afterSeq: number, kind: FlipEvent['kind'] | null, limit: number): FlipEvent[] {
    const out: FlipEvent[] = [];
    for (const e of this.events) {
      if (e.seq <= afterSeq) continue;
      if (kind && e.kind !== kind) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  stats() {
    let slots = 0;
    let available = 0;
    let emptyCombos = 0;
    for (const c of this.combos.values()) {
      slots += c.slots.length;
      if (c.slots.length === 0) emptyCombos++;
      for (const s of c.slots) if (s.quota > 0) available++;
    }
    const released = this.events.filter((e) => e.kind === 'released').length;
    return {
      combos: this.combos.size,
      emptyCombos,
      slots,
      available,
      requests: this.requests,
      events: this.events.length,
      released,
      lastSeq: this.seq,
      resetAt: this.resetAt,
      config: this.config,
    };
  }
}
