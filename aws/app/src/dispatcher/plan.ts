/**
 * dispatcher 的分段排程，純函式、不碰 IO。
 *
 * dispatcher 是無狀態的（契約第 4 節）：不連資料庫、不記游標，
 * 改用「從 epoch 起算的分鐘數」決定這一輪輪到哪一段。
 *
 *   熱門 108 組，每分鐘 11 組 → 第 m 分鐘取 [(m*11) % 108, +11)，約 9.8 分鐘輪完
 *   冷門 252 組，每分鐘 3 組  → 第 m 分鐘取 [(m*3) % 252, +3)，84 分鐘輪完
 *
 * 長期沒場次的組合照樣派出，由 worker 查 scan_log 決定要不要跳過（降頻），
 * 被跳過的任務不會對官網發請求。
 */
import { createHash } from 'node:crypto';
import { hotCombos, coldCombos, type Combo } from '../../../../src/catalogue.ts';
import {
  CONTRACT_VERSION,
  LIVE_MAX_TASKS_PER_MINUTE,
  type ScanTask,
  type ScanTarget,
  type ScanTier,
} from '../../../shared/contracts.ts';
import { intOr, type Env } from '../config.ts';

export const HOT = hotCombos();
export const COLD = coldCombos();

export const DEFAULT_HOT_PER_TICK = 11;
export const DEFAULT_COLD_PER_TICK = 3;

export type DispatchConfig = { target: ScanTarget; hotPerTick: number; coldPerTick: number };

/**
 * 讀環境變數並套上禮貌上限。
 * live 模式下兩者合計超過 14 時先砍冷門、再砍熱門，並回傳警告讓 handler 記 log，
 * 而不是直接丟例外 —— 設定打錯時寧可少掃，也不要整個停擺或多打官網。
 */
export function dispatchConfig(env: Env): { config: DispatchConfig; warnings: string[] } {
  const warnings: string[] = [];
  const rawTarget = (env.SCAN_TARGET ?? 'live').trim() || 'live';
  let target: ScanTarget;
  if (rawTarget === 'live' || rawTarget === 'replay') {
    target = rawTarget;
  } else {
    // 不認得的值一律當 live 處理，才會套上 14 的上限
    warnings.push(`SCAN_TARGET=${rawTarget} 不是 live/replay，當作 live`);
    target = 'live';
  }

  let hot = intOr(env.HOT_PER_TICK, DEFAULT_HOT_PER_TICK);
  let cold = intOr(env.COLD_PER_TICK, DEFAULT_COLD_PER_TICK);
  hot = Math.min(hot, HOT.length);
  cold = Math.min(cold, COLD.length);

  if (target === 'live' && hot + cold > LIVE_MAX_TASKS_PER_MINUTE) {
    const origHot = hot;
    const origCold = cold;
    hot = Math.min(hot, LIVE_MAX_TASKS_PER_MINUTE);
    cold = Math.min(cold, LIVE_MAX_TASKS_PER_MINUTE - hot);
    warnings.push(
      `live 模式每分鐘最多 ${LIVE_MAX_TASKS_PER_MINUTE} 則，HOT_PER_TICK=${origHot}、COLD_PER_TICK=${origCold} 已調整為 ${hot}、${cold}`,
    );
  }
  return { config: { target, hotPerTick: hot, coldPerTick: cold }, warnings };
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
 * 由（分鐘, 層, 目標, 組合）決定的 UUID（RFC 4122 v5 格式，SHA-1）。
 *
 * EventBridge 是 at-least-once，同一分鐘可能觸發兩次。taskId 固定之後，
 * 重複送出的任務在 worker 端會被 scan_task_log 的冪等檢查擋掉，
 * 不會因為重複觸發而多打官網。
 */
export function deterministicTaskId(minute: number, tier: ScanTier, target: ScanTarget, c: Combo): string {
  const h = createHash('sha1').update(`mvdis-scan|${minute}|${tier}|${target}|${c.licenseType}|${c.dmvNo}`).digest();
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
    taskId: deterministicTaskId(minute, tier, config.target, c),
    licenseType: c.licenseType,
    lv1: c.lv1,
    dmvNo: c.dmvNo,
    tier,
    target: config.target,
    runId: null,
    enqueuedAt: nowMs,
  });
  const tasks = [
    ...segment(HOT, minute, config.hotPerTick).map(make('hot')),
    ...segment(COLD, minute, config.coldPerTick).map(make('cold')),
  ];
  // 最後一道防線：就算上面哪裡算錯，live 也絕不超過上限
  if (config.target === 'live' && tasks.length > LIVE_MAX_TASKS_PER_MINUTE) {
    return tasks.slice(0, LIVE_MAX_TASKS_PER_MINUTE);
  }
  return tasks;
}
