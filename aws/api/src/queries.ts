/**
 * 儀表板查詢：原型 src/db.ts「儀表板查詢」與「每站公開頁面」兩段的 Postgres 版。
 *
 * 輸出格式必須和原型（D1／SQLite）逐欄一致，前端與外部使用者都直接吃這些列：
 *   - 欄位一律明列，不用 `SELECT *`：slot_event 在 AWS 版多了 task_id、run_id，不能漏出去。
 *   - 型別轉換（DATE → 字串、BOOLEAN → 0／1、BIGINT → number）在 db.ts 的 type parser 統一處理。
 *   - 文字欄位排序加 `COLLATE "C"`：SQLite 是位元組序，RDS 預設的 en_US.UTF-8 排序規則不是。
 */
import type { Queryable } from './db.ts';

export type SlotRow = {
  license_type: string;
  dmv_no: string;
  exam_date: string;
  sec_key: string;
  quota: number;
  signup_available: number;
  sec_desc: string | null;
  session: string | null;
  grp: number | null;
  weekday: string | null;
  is_weekend: number;
  first_seen: number;
  updated_at: number;
  seen_at: number;
};

export type EventRow = {
  id: number;
  license_type: string;
  dmv_no: string;
  exam_date: string;
  sec_key: string;
  kind: 'released' | 'increased' | 'decreased' | 'filled' | 'new' | 'gone';
  old_quota: number | null;
  new_quota: number | null;
  at: number;
};

export type ScanLogRow = {
  license_type: string;
  dmv_no: string;
  last_ok: number | null;
  last_error: string | null;
  last_error_at: number | null;
  rows_seen: number;
  empty_streak: number;
  duration_ms: number | null;
};

/** 和原型 slot 表欄位順序相同（SQLite 的 SELECT * 就是這個順序） */
const SLOT_COLS = `license_type, dmv_no, exam_date, sec_key, quota, signup_available, sec_desc, session,
  grp, weekday, is_weekend, first_seen, updated_at, seen_at`;

/** 原型 slot_event 表的欄位；不含 AWS 版新增的 task_id、run_id */
const EVENT_COLS = 'id, license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at';

/**
 * 同一個 `at` 的事件怎麼排。worker 同一輪寫入的事件 `at` 都相同，所以這個順序在正式資料裡天天都會碰到。
 * 原型的 `ORDER BY at DESC` 走 idx_event_at／idx_event_kind_at／idx_event_station，
 * SQLite 索引內同鍵值依 rowid 遞增，實際結果是 id ASC；這裡明寫出來讓兩邊一致。
 */
const EVENT_TIE = 'id ASC';

const INT4_MAX = 2147483647;

/** 原型是 `Math.min(Math.max(n, 1), max)`；另外取整數，`LIMIT` 內插的一定是整數 */
const clampLimit = (n: number, max: number) => Math.trunc(Math.min(Math.max(n, 1), max));

const SCAN_LOG_COLS = 'license_type, dmv_no, last_ok, last_error, last_error_at, rows_seen, empty_streak, duration_ms';

export type AvailableFilter = {
  dmvNo?: string;
  licenseType?: string;
  from?: string;
  to?: string;
  weekendOnly?: boolean;
  minQuota?: number;
  limit?: number;
};

export async function queryAvailable(db: Queryable, f: AvailableFilter, dmvNosForCounty?: string[]): Promise<SlotRow[]> {
  const binds: unknown[] = [];
  const bind = (v: unknown) => {
    binds.push(v);
    return `$${binds.length}`;
  };
  // quota 是整數，`quota >= 2.5` 等於 `quota >= 3`；上限夾在 int4 範圍內，超大值不會讓 Postgres 溢位成 500
  // （原型的 SQLite 是 64 位元整數，超大值只會查不到東西）
  const minQuota = Math.min(Math.ceil(Math.max(1, f.minQuota ?? 1)), INT4_MAX);
  const where: string[] = [`quota >= ${bind(minQuota)}`];

  if (f.dmvNo) where.push(`dmv_no = ${bind(f.dmvNo)}`);
  else if (dmvNosForCounty && dmvNosForCounty.length) where.push(`dmv_no = ANY(${bind(dmvNosForCounty)}::text[])`);
  if (f.licenseType) where.push(`license_type = ${bind(f.licenseType)}`);
  if (f.from) where.push(`exam_date >= ${bind(f.from)}::date`);
  if (f.to) where.push(`exam_date <= ${bind(f.to)}::date`);
  if (f.weekendOnly) where.push('is_weekend');

  const limit = clampLimit(f.limit ?? 300, 1000);
  // 原型只排 exam_date、quota；同分時 SQLite 的順序本來就沒有保證，這裡補上主鍵讓結果穩定
  const sql = `SELECT ${SLOT_COLS} FROM slot WHERE ${where.join(' AND ')}
    ORDER BY exam_date ASC, quota DESC, license_type COLLATE "C", dmv_no COLLATE "C", sec_key COLLATE "C"
    LIMIT ${limit}`;
  return (await db.query<SlotRow>(sql, binds)).rows;
}

/** 每個「監理站 × 照類」今天起有位的場次數、名額數與最近日期（原型直接寫在 index.ts） */
export async function queryOverview(db: Queryable, today: string) {
  const r = await db.query<{ dmv_no: string; license_type: string; slots: number; seats: number; nearest: string }>(
    `SELECT dmv_no, license_type, COUNT(*) AS slots, SUM(quota) AS seats, MIN(exam_date) AS nearest
     FROM slot WHERE quota > 0 AND exam_date >= $1::date
     GROUP BY dmv_no, license_type
     ORDER BY dmv_no COLLATE "C", license_type COLLATE "C"`,
    [today],
  );
  return r.rows;
}

export async function queryEvents(db: Queryable, kind: string | null, limit: number): Promise<EventRow[]> {
  const lim = clampLimit(limit, 500);
  const r = kind
    ? await db.query<EventRow>(`SELECT ${EVENT_COLS} FROM slot_event WHERE kind = $1 ORDER BY at DESC, ${EVENT_TIE} LIMIT ${lim}`, [kind])
    : await db.query<EventRow>(`SELECT ${EVENT_COLS} FROM slot_event ORDER BY at DESC, ${EVENT_TIE} LIMIT ${lim}`);
  return r.rows;
}

export async function queryCombo(db: Queryable, licenseType: string, dmvNo: string): Promise<SlotRow[]> {
  const r = await db.query<SlotRow>(
    `SELECT ${SLOT_COLS} FROM slot WHERE license_type = $1 AND dmv_no = $2 ORDER BY exam_date ASC, sec_key COLLATE "C" ASC`,
    [licenseType, dmvNo],
  );
  return r.rows;
}

export async function scanHealth(db: Queryable) {
  const r = await db.query(
    `SELECT COUNT(*) AS combos,
            MAX(last_ok) AS newest,
            MIN(COALESCE(last_ok, 0)) AS oldest,
            SUM(CASE WHEN empty_streak >= 5 THEN 1 ELSE 0 END) AS pruned,
            SUM(CASE WHEN last_error_at > COALESCE(last_ok, 0) THEN 1 ELSE 0 END) AS failing
     FROM scan_log`,
  );
  return r.rows[0] ?? {};
}

/**
 * 原型的 `lastTick` 來自 scan_state 的 `last_tick`（cron 每輪結束寫一次）。AWS 版沒有 scan_state，
 * 改成「最近一次有組合被掃（成功或失敗）的時間」：scan_log 的 last_ok／last_error_at 取最大。
 *
 * 為什麼不用 scan_task_log.finished_at：那張表每個 SQS 任務一列、會一直長，而現有的
 * idx_task_run (run_id, finished_at) 對 `WHERE run_id IS NULL` 做不到 min/max 最佳化
 * （EXPLAIN 是 Index Only Scan 全段＋Sort），每次 /api/meta 都要掃過所有一般排程任務。
 * scan_log 最多 360 列（36 站 × 10 照類），成本固定。
 */
export async function queryLastTick(db: Queryable): Promise<number | null> {
  const r = await db.query<{ last_tick: number | null }>(
    'SELECT GREATEST(MAX(last_ok), MAX(last_error_at)) AS last_tick FROM scan_log',
  );
  return r.rows[0]?.last_tick ?? null;
}

/** 該站全部照類、今天起的所有場次，**包含額滿**。走 idx_slot_station。 */
export async function queryStationSlots(db: Queryable, dmvNo: string, from: string): Promise<SlotRow[]> {
  const r = await db.query<SlotRow>(
    `SELECT ${SLOT_COLS} FROM slot WHERE dmv_no = $1 AND exam_date >= $2::date
     ORDER BY license_type COLLATE "C", exam_date, sec_key COLLATE "C"`,
    [dmvNo, from],
  );
  return r.rows;
}

/** 該站最近的事件流，給統計與歷史列表用。走 idx_event_station。 */
export async function queryStationEvents(db: Queryable, dmvNo: string, since: number, limit = 5000): Promise<EventRow[]> {
  const lim = clampLimit(limit, 10000);
  const r = await db.query<EventRow>(
    `SELECT ${EVENT_COLS} FROM slot_event WHERE dmv_no = $1 AND at >= $2 ORDER BY at DESC, ${EVENT_TIE} LIMIT ${lim}`,
    [dmvNo, since],
  );
  return r.rows;
}

/** 該站每個照類的掃描健康度 */
export async function queryStationScanLog(db: Queryable, dmvNo: string): Promise<ScanLogRow[]> {
  const r = await db.query<ScanLogRow>(
    `SELECT ${SCAN_LOG_COLS} FROM scan_log WHERE dmv_no = $1 ORDER BY license_type COLLATE "C"`,
    [dmvNo],
  );
  return r.rows;
}
