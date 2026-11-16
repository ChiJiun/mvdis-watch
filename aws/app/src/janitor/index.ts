/**
 * janitor Lambda：EventBridge 每日觸發一次（台灣時間 04:00），清掉不再需要的資料（契約 §7）：
 *   - 30 天前的 slot_event（原型 scan.ts 的 EVENT_RETENTION_MS）
 *   - 考試日已過（早於台灣時間今天）的 slot
 *   - 30 天前的 scan_task_log
 * slot／slot_event 在 public 與 replay 兩個 schema 都要清（契約 §7.3）；scan_task_log 只在 public。
 *
 * 需要 DB，放 VPC private 應用層、套 Worker-SG；連線設定和 worker 相同（DATABASE_URL 或 DB_* + DB_SECRET_ARN）。
 */
import { taipeiIsoDate } from '../../../shared/contracts.ts';
import type { Env } from '../config.ts';
import { createPool, DEFAULT_SCHEMAS, schemaIdent, type DbSchemas, type Pool } from '../db.ts';

export const RETENTION_MS = 30 * 24 * 3600 * 1000;

export type CleanupResult = { slotEvents: number; slots: number; taskLogs: number; today: string };

export async function cleanup(pool: Pool, now: number, schemas: DbSchemas = DEFAULT_SCHEMAS): Promise<CleanupResult> {
  const cutoff = now - RETENTION_MS;
  const today = taipeiIsoDate(now); // 「今天」用台灣日期，同原型 todayIso
  let slotEvents = 0;
  let slots = 0;
  // 每個 DELETE 互不相依，各自提交；中途失敗下次再跑也只是補刪
  for (const s of new Set([schemas.live, schemas.replay].map(schemaIdent))) {
    slotEvents += (await pool.query(`DELETE FROM ${s}.slot_event WHERE at < $1`, [cutoff])).rowCount ?? 0;
    slots += (await pool.query(`DELETE FROM ${s}.slot WHERE exam_date < $1::date`, [today])).rowCount ?? 0;
  }
  const tl = await pool.query(`DELETE FROM ${schemaIdent(schemas.live)}.scan_task_log WHERE enqueued_at < $1`, [cutoff]);
  return { slotEvents, slots, taskLogs: tl.rowCount ?? 0, today };
}

// Lambda 容器重用時沿用同一個連線池
let pool: Pool | undefined;

export async function handler(): Promise<CleanupResult> {
  pool ??= await createPool(process.env as Env, 1);
  const r = await cleanup(pool, Date.now());
  console.log(JSON.stringify({ level: 'info', msg: 'janitor done', ...r }));
  return r;
}
