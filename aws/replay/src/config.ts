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

/**
 * 每個可調參數的合法範圍。環境變數（loadConfig）和 POST /admin/reset（validateReset）共用同一份，
 * 避免 /admin/reset 能設出啟動時會被擋下的值（例如 maxEvents=0 讓事件永遠是空的、tickMs=1 吃滿 CPU）。
 */
export const PARAM_RULES = {
  seed: { check: (n: number) => Number.isInteger(n), desc: '整數' },
  flipProb: { check: (n: number) => n >= 0 && n <= 1, desc: '0–1' },
  tickMs: { check: (n: number) => n === 0 || (n >= 10 && n <= 3_600_000), desc: '0（關閉）或 10–3600000' },
  flipsPerTick: { check: (n: number) => Number.isInteger(n) && n >= 0 && n <= 10_000, desc: '0–10000 的整數' },
  fullRatio: { check: (n: number) => n >= 0 && n <= 1, desc: '0–1' },
  horizonDays: { check: (n: number) => Number.isInteger(n) && n >= 1 && n <= 120, desc: '1–120 的整數' },
  maxEvents: { check: (n: number) => Number.isInteger(n) && n >= 1 && n <= 1_000_000, desc: '1–1000000 的整數' },
  delayMs: { check: (n: number) => n >= 0 && n <= 60_000, desc: '0–60000' },
  jitterMs: { check: (n: number) => n >= 0 && n <= 60_000, desc: '0–60000' },
} as const satisfies Record<keyof ReplayConfig | 'delayMs' | 'jitterMs', { check: (n: number) => boolean; desc: string }>;

export type ParamKey = keyof typeof PARAM_RULES;

/** 檢查單一參數；不合法時丟錯，訊息包含合法範圍 */
export function checkParam(key: ParamKey, n: number, label: string = key): number {
  if (!Number.isFinite(n) || !PARAM_RULES[key].check(n)) throw new Error(`${label}=${n} 不合法（需為 ${PARAM_RULES[key].desc}）`);
  return n;
}

function param(env: Env, envKey: string, key: ParamKey, fallback: number): number {
  const raw = env[envKey];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`環境變數 ${envKey}=${raw} 不合法`);
  return checkParam(key, n, `環境變數 ${envKey}`);
}

export function loadConfig(env: Env): { port: number; config: ReplayConfig; options: ServerOptions } {
  return {
    port: num(env, 'PORT', 8080, (n) => Number.isInteger(n) && n > 0 && n < 65536),
    config: {
      seed: param(env, 'REPLAY_SEED', 'seed', DEFAULT_CONFIG.seed),
      flipProb: param(env, 'REPLAY_FLIP_PROB', 'flipProb', DEFAULT_CONFIG.flipProb),
      tickMs: param(env, 'REPLAY_TICK_MS', 'tickMs', DEFAULT_CONFIG.tickMs),
      flipsPerTick: param(env, 'REPLAY_FLIPS_PER_TICK', 'flipsPerTick', DEFAULT_CONFIG.flipsPerTick),
      fullRatio: param(env, 'REPLAY_FULL_RATIO', 'fullRatio', DEFAULT_CONFIG.fullRatio),
      horizonDays: param(env, 'REPLAY_HORIZON_DAYS', 'horizonDays', DEFAULT_CONFIG.horizonDays),
      maxEvents: param(env, 'REPLAY_MAX_EVENTS', 'maxEvents', DEFAULT_CONFIG.maxEvents),
    },
    options: {
      // 官網實際回應時間沒有校準過，500±250 ms 是假設值，實驗前可用環境變數或 /admin/reset 調整
      delayMs: param(env, 'REPLAY_DELAY_MS', 'delayMs', 500),
      jitterMs: param(env, 'REPLAY_JITTER_MS', 'jitterMs', 250),
      adminToken: env.REPLAY_ADMIN_TOKEN || null,
    },
  };
}
