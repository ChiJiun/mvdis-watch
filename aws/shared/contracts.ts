/**
 * AWS 版各元件之間的訊息格式。改這裡等於改契約，請同步更新 aws/CONTRACTS.md。
 *
 * 只放型別、常數與純函式，不放任何會碰 IO 的程式，任何一條開發線都可以直接 import。
 */

export const CONTRACT_VERSION = 1 as const;

export type ScanTier = 'hot' | 'cold';
export type ScanTarget = 'live' | 'replay';

/** live 模式下 dispatcher 每分鐘最多送出的任務數（對官網的禮貌上限） */
export const LIVE_MAX_TASKS_PER_MINUTE = 14;

/** live 任務從 enqueuedAt 起超過這個時間就視為過期，worker 不抓（CONTRACTS.md §4.2） */
export const LIVE_TASK_MAX_AGE_MS = 120_000;

/** replay 任務絕對不能打到的網域（含子網域） */
export const LIVE_HOSTNAME = 'mvdis.gov.tw';

/** SQS `mvdis-scan` 的訊息 body */
export type ScanTask = {
  v: typeof CONTRACT_VERSION;
  /** UUID，worker 用它做冪等 */
  taskId: string;
  licenseType: string;
  lv1: string;
  dmvNo: string;
  tier: ScanTier;
  target: ScanTarget;
  /** 一般排程為 null；實驗灌入的任務帶同一個 runId。target=live 時必須為 null */
  runId: string | null;
  /** epoch ms */
  enqueuedAt: number;
};

/** scan_task_log.outcome */
export type TaskOutcome = 'ok' | 'error' | 'skipped' | 'stale' | 'rejected';

/** 和原型 src/db.ts 的 EventKind 相同 */
export type EventKind = 'released' | 'increased' | 'decreased' | 'filled' | 'new' | 'gone';

/** 寫進 S3 events/ 的每一行，也是 slot_event 表的一列 */
export type SlotEvent = {
  licenseType: string;
  dmvNo: string;
  /** ISO yyyy-mm-dd */
  examDate: string;
  secKey: string;
  kind: EventKind;
  oldQuota: number | null;
  newQuota: number | null;
  /** epoch ms */
  at: number;
  /** AWS 版產生的事件一定有；從原型匯入的歷史事件為 null */
  taskId: string | null;
  runId: string | null;
};

/** SNS `mvdis-events` 的訊息 body；訊息屬性 `target`（DataType String）另外帶 ScanTarget */
export type ReleasedEvent = SlotEvent & {
  kind: 'released';
  target: ScanTarget;
};

/** notifier 訂閱的 SNS filter policy */
export const NOTIFIER_FILTER_POLICY = { target: ['live'] } as const;

/** 官網查詢端點的路徑；live 用 `${MVDIS_LIVE_URL}${MVDIS_PATH}`，replay 用 `${REPLAY_BASE_URL}${MVDIS_PATH}` */
export const MVDIS_PATH = '/m3-emv-trn/exm/locations';

/** 官網查詢表單（和原型 src/mvdis.ts 的 querySlots 相同）；Replay 站必須接受同一組欄位 */
export function mvdisFormFields(input: {
  licenseType: string;
  lv1: string;
  dmvNo: string;
  /** 民國日期 yyyMMdd */
  dateStr: string;
  onlyWeekend?: boolean;
}): Record<string, string> {
  const f: Record<string, string> = {
    method: 'query',
    licenseTypeCode: input.licenseType,
    expectExamDateStr: input.dateStr,
    _onlyWeekend: 'on',
    dmvNoLv1: input.lv1,
    dmvNo: input.dmvNo,
    secDateStr: '',
    secId: '',
    divId: '',
  };
  if (input.onlyWeekend) f.onlyWeekend = 'true';
  return f;
}

/**
 * Postgres → JS 的型別轉換規則（CONTRACTS.md §7.1）。所有連 DB 的服務都要套用，例如：
 *   for (const [oid, parse] of Object.entries(PG_TYPE_RULES)) pg.types.setTypeParser(Number(oid), parse);
 */
export const PG_TYPE_RULES: Record<number, (v: string) => unknown> = {
  1082: (v) => v, // date → 'yyyy-mm-dd'
  20: (v) => Number(v), // int8
  1700: (v) => Number(v), // numeric
  16: (v) => (v === 't' ? 1 : 0), // bool → 0/1
};

/**
 * 各 target 的 slot／slot_event／scan_log 所在的 Postgres schema（CONTRACTS.md §7.3）。
 * scan_task_log 一律在 public。worker 在交易內執行 `SET LOCAL search_path = <schema>, public`。
 */
export const DB_SCHEMA_BY_TARGET: Record<ScanTarget, 'public' | 'replay'> = {
  live: 'public',
  replay: 'replay',
};

/** 台灣時間的 ISO 日期，S3 dt 分區用 */
export function taipeiIsoDate(epochMs: number): string {
  return new Date(epochMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * S3 物件鍵。isoDate 一律用 taipeiIsoDate(scan_task_log.committed_at)，補做副作用時也用同一個值，
 * 鍵只由 taskId 決定，同一個任務重做只會覆寫同一個物件（CONTRACTS.md §5）。
 */
export const s3Keys = {
  raw: (isoDate: string, licenseType: string, dmvNo: string, taskId: string) =>
    `raw/dt=${isoDate}/license=${licenseType}/dmv=${dmvNo}/${taskId}.html.gz`,
  events: (isoDate: string, taskId: string) => `events/dt=${isoDate}/${taskId}.jsonl`,
  release: (name: string) => `releases/${name}`,
};

/** CloudWatch EMF */
export const METRIC_NAMESPACE = 'MvdisWatch';
export type MetricName = 'ScanDurationMs' | 'ScanErrors' | 'ReleasedEvents';
