/**
 * dispatcher 的分段排程（契約 §4.1），純函式、不碰 IO。
 *
 * dispatcher 是無狀態的：不連資料庫、不記游標，用 m = floor(Date.now() / 60000) 決定這一輪輪到哪一段：
 *
 *   hotStart  = (m * HOT_PER_TICK)  mod 108 → 取 HOT[hotStart …] 共 HOT_PER_TICK 組（超過尾端繞回）
 *   coldStart = (m * COLD_PER_TICK) mod 252 → 取 COLD[coldStart …] 共 COLD_PER_TICK 組
 *
 * 預設 11 + 3：熱門約 9.8 分鐘輪完，冷門 84 分鐘輪完。送出的任務一律 target=live、runId=null。
 * 長期沒場次的組合照樣派出，由 worker 查 scan_log 決定要不要跳過（降頻），被跳過的不會對官網發請求。
 */
import { createHash } from 'node:crypto';
import { hotCombos, coldCombos, type Combo } from '../../../../src/catalogue.ts';
import { CONTRACT_VERSION, LIVE_MAX_TASKS_PER_MINUTE, type ScanTask, type ScanTier } from '../../../shared/contracts.ts';
import type { Env } from '../config.ts';

export const HOT = hotCombos();
export const COLD = coldCombos();

export const DEFAULT_HOT_PER_TICK = 11;
export const DEFAULT_COLD_PER_TICK = 3;

export type DispatchConfig = { hotPerTick: number; coldPerTick: number };

export class DispatchConfigError extends Error {}

/** 未設定（或空字串）回預設值；有設就必須是非負整數字串，否則丟 DispatchConfigError */
function perTick(env: Env, name: 'HOT_PER_TICK' | 'COLD_PER_TICK', fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new DispatchConfigError(`${name}=${JSON.stringify(raw)} 不是非負整數，拒絕執行`);
  return Number(raw.trim());
}

/**
 * 讀 HOT_PER_TICK／COLD_PER_TICK（契約 §3）：未設定用預設 11、3；必須是非負整數且合計 1–14，
 * 否則丟 DispatchConfigError —— 契約規定 dispatcher 要拒絕執行、不送任何任務。
 */
export function dispatchConfig(env: Env): DispatchConfig {
  const hot = perTick(env, 'HOT_PER_TICK', DEFAULT_HOT_PER_TICK);
  const cold = perTick(env, 'COLD_PER_TICK', DEFAULT_COLD_PER_TICK);
  const total = hot + cold;
  if (total < 1 || total > LIVE_MAX_TASKS_PER_MINUTE) {
    throw new DispatchConfigError(
      `HOT_PER_TICK(${hot}) + COLD_PER_TICK(${cold}) = ${total}，必須在 1–${LIVE_MAX_TASKS_PER_MINUTE} 之間，拒絕執行`,
    );
  }
  return { hotPerTick: hot, coldPerTick: cold };
}

export function epochMinute(nowMs: number): number {
  return Math.floor(nowMs / 60_000);
}

/** 第 minute 分鐘輪到的那一段，連續的分鐘會接續下去，跨過尾端就繞回開頭 */
export function segment<T>(list: readonly T[], minute: number, perTick: number): T[] {
  const n = Math.min(perTick, list.length);
  if (n <= 0 || list.length === 0) return [];
  const start = (((minute * perTick) % list.length) + list.length) % list.length;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[(start + i) % list.length]);
  return out;
}

/**
 * 由（分鐘, 層, 組合）決定的 UUID（RFC 4122 v5 格式，SHA-1）。
 *
 * EventBridge 是 at-least-once，同一分鐘可能觸發兩次。taskId 固定之後，
 * 重複送出的任務在 worker 端會被 scan_task_log 的冪等檢查擋掉。
 */
export function deterministicTaskId(minute: number, tier: ScanTier, c: Combo): string {
  const h = createHash('sha1').update(`mvdis-scan|${minute}|${tier}|live|${c.licenseType}|${c.dmvNo}`).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function planTick(nowMs: number, config: DispatchConfig): ScanTask[] {
  const minute = epochMinute(nowMs);
  const make = (tier: ScanTier) => (c: Combo): ScanTask => ({
    v: CONTRACT_VERSION,
    taskId: deterministicTaskId(minute, tier, c),
    licenseType: c.licenseType,
    lv1: c.lv1,
    dmvNo: c.dmvNo,
    tier,
    target: 'live',
    runId: null,
    enqueuedAt: nowMs,
  });
  const tasks = [
    ...segment(HOT, minute, config.hotPerTick).map(make('hot')),
    ...segment(COLD, minute, config.coldPerTick).map(make('cold')),
  ];
  // 最後一道防線：就算 config 被繞過，也絕不超過上限
  if (tasks.length > LIVE_MAX_TASKS_PER_MINUTE) {
    throw new DispatchConfigError(`本輪 ${tasks.length} 則超過上限 ${LIVE_MAX_TASKS_PER_MINUTE}，拒絕執行`);
  }
  return tasks;
}
