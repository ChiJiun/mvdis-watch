/**
 * 從環境變數讀設定（契約第 3 節：所有服務只從環境變數讀設定）。
 * 數字解析失敗時直接丟錯讓服務起不來，比默默用預設值跑錯實驗好。
 */
import { DEFAULT_CONFIG, type ReplayConfig } from './generator.ts';
import type { ServerOptions } from './server.ts';

export type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number, check?: (n: number) => boolean): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || (check && !check(n))) throw new Error(`環境變數 ${key}=${raw} 不合法`);
  return n;
}

const nonNeg = (n: number) => n >= 0;
const prob = (n: number) => n >= 0 && n <= 1;

export function loadConfig(env: Env): { port: number; config: ReplayConfig; options: ServerOptions } {
  return {
    port: num(env, 'PORT', 8080, (n) => Number.isInteger(n) && n > 0 && n < 65536),
    config: {
      seed: num(env, 'REPLAY_SEED', DEFAULT_CONFIG.seed),
      flipProb: num(env, 'REPLAY_FLIP_PROB', DEFAULT_CONFIG.flipProb, prob),
      tickMs: num(env, 'REPLAY_TICK_MS', DEFAULT_CONFIG.tickMs, nonNeg),
      flipsPerTick: num(env, 'REPLAY_FLIPS_PER_TICK', DEFAULT_CONFIG.flipsPerTick, nonNeg),
      fullRatio: num(env, 'REPLAY_FULL_RATIO', DEFAULT_CONFIG.fullRatio, prob),
      horizonDays: num(env, 'REPLAY_HORIZON_DAYS', DEFAULT_CONFIG.horizonDays, (n) => n >= 1 && n <= 120),
      maxEvents: num(env, 'REPLAY_MAX_EVENTS', DEFAULT_CONFIG.maxEvents, (n) => n >= 1),
    },
    options: {
      // 官網實際回應時間沒有校準過，500±250 ms 是假設值，實驗前可用環境變數或 /admin/reset 調整
      delayMs: num(env, 'REPLAY_DELAY_MS', 500, nonNeg),
      jitterMs: num(env, 'REPLAY_JITTER_MS', 250, nonNeg),
      adminToken: env.REPLAY_ADMIN_TOKEN || null,
    },
  };
}
