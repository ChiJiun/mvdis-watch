/**
 * AWS 版各元件之間的訊息格式。改這裡等於改契約，請同步更新 aws/CONTRACTS.md。
 *
 * 只放型別與常數，不放任何會碰 IO 的程式，任何一條開發線都可以直接 import。
 */

export const CONTRACT_VERSION = 1 as const;

export type ScanTier = 'hot' | 'cold';
export type ScanTarget = 'live' | 'replay';

/** live 模式下 dispatcher 每分鐘最多送出的任務數（對官網的禮貌上限） */
export const LIVE_MAX_TASKS_PER_MINUTE = 14;

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
  /** 一般排程為 null；實驗灌入的任務帶同一個 runId */
  runId: string | null;
  /** epoch ms */
  enqueuedAt: number;
};

/** 和原型 src/db.ts 的 EventKind 相同 */
export type EventKind = 'released' | 'increased' | 'decreased' | 'filled' | 'new' | 'gone';

/** 寫進 S3 events/ 的每一行，也是 slot_event 表的一列 */
export type SlotEvent = {
  licenseType: string;
  dmvNo: string;
  examDate: string;
  secKey: string;
  kind: EventKind;
  oldQuota: number | null;
  newQuota: number | null;
  /** epoch ms */
  at: number;
  taskId: string;
  runId: string | null;
};

/** SNS `mvdis-events` 的訊息 body；訊息屬性 `target` 另外帶 ScanTarget */
export type ReleasedEvent = SlotEvent & {
  kind: 'released';
  target: ScanTarget;
};

/** 官網查詢端點的路徑；worker 一律用 `${MVDIS_BASE_URL}${MVDIS_PATH}` */
export const MVDIS_PATH = '/m3-emv-trn/exm/locations';

/** S3 物件鍵 */
export const s3Keys = {
  raw: (isoDate: string, licenseType: string, dmvNo: string, epochMs: number) =>
    `raw/dt=${isoDate}/license=${licenseType}/dmv=${dmvNo}/${epochMs}.html.gz`,
  events: (isoDate: string, taskId: string) => `events/dt=${isoDate}/${taskId}.jsonl`,
  release: (name: string) => `releases/${name}`,
};

/** CloudWatch EMF */
export const METRIC_NAMESPACE = 'MvdisWatch';
export type MetricName = 'ScanDurationMs' | 'ScanErrors' | 'ReleasedEvents';
