/**
 * 單機部署用的排程器：取代 AWS 上的 EventBridge。
 *   - 每分鐘呼叫一次 dispatcher（和 Lambda 版同一份核心 `dispatch()`）
 *   - 每天台灣時間 04:00 之後第一次 tick 呼叫 janitor（契約 §7）
 *   - 每天台灣時間 04:10 之後第一次 tick 刪掉 RAW_RETENTION_DAYS 天前的 S3 raw/ 物件
 *     （LocalStack 的 S3 把小物件放在記憶體，不清會一直長；AWS 版靠 S3 lifecycle，不需要這段）
 *
 * 環境變數和 dispatcher／janitor 相同（見 aws/CONTRACTS.md §3），另外：
 *   DISPATCH_ENABLED：只接受 0 或 1，其他值（含空值）啟動時直接報錯結束，避免誤開 live 派送。
 *   RAW_RETENTION_DAYS：raw/ 保留天數，預設 3；設 0 表示不清。
 *
 * 一台主機只能跑一個 scheduler（不要 --scale），否則每分鐘的官網請求會加倍。
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { dispatch, sqsSendBatch } from '../../app/src/dispatcher/index.ts';
import { handler as janitor } from '../../app/src/janitor/index.ts';
import { taipeiIsoDate } from '../../shared/contracts.ts';

const env = process.env;
const MINUTE_MS = 60_000;
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;

function log(level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, msg, at: new Date().toISOString(), ...extra }));
}

function intEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} 必須是非負整數，收到 ${raw}`);
  return n;
}

/** fail-closed：只有明確的 0／1 才接受 */
export function parseDispatchEnabled(raw: string | undefined): boolean {
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new Error(`DISPATCH_ENABLED 只能是 0 或 1，收到 ${JSON.stringify(raw ?? null)}`);
}

/** 刪掉 dt 分區早於 (台灣今天 - days) 的 raw/ 物件；鍵格式見 contracts.ts 的 s3Keys.raw */
export async function pruneRaw(s3: S3Client, bucket: string, now: number, days: number) {
  const cutoff = taipeiIsoDate(now - days * 24 * 3600 * 1000);
  let deleted = 0;
  const failed: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: 'raw/', ContinuationToken: token }),
    );
    const old = (page.Contents ?? [])
      .map((o) => o.Key!)
      .filter((k) => {
        const m = /^raw\/dt=(\d{4}-\d{2}-\d{2})\//.exec(k);
        return m !== null && m[1] < cutoff;
      });
    for (let i = 0; i < old.length; i += 1000) {
      const chunk = old.slice(i, i + 1000);
      const res = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }),
      );
      const errs = res.Errors ?? [];
      deleted += chunk.length - errs.length;
      failed.push(...errs.map((e) => `${e.Key}:${e.Code}`));
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { deleted, failed: failed.slice(0, 20), failedCount: failed.length, cutoff };
}

/** 台灣時間的「當天第幾分鐘」 */
function taipeiMinuteOfDay(now: number): number {
  const t = new Date(now + TAIPEI_OFFSET_MS);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

async function safe(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    log('info', `${name} ok`, { result: r });
  } catch (e) {
    log('error', `${name} failed`, { error: e instanceof Error ? e.message : String(e) });
  }
}

export type SchedulerDeps = {
  dispatchEnabled: boolean;
  rawRetentionDays: number;
  dispatchAt: (nowMs: number) => Promise<unknown>;
  runJanitor: () => Promise<unknown>;
  runPrune: (nowMs: number) => Promise<unknown>;
};

/**
 * 一個 tick 的狀態機。`now` 可以早於或晚於整分鐘幾毫秒（libuv timer 和 Date.now() 有落差），
 * 所以用四捨五入取「這一輪是哪一分鐘」，同一分鐘只派送一次。
 * janitor／prune 用「台灣時間過了 04:00／04:10、而且今天還沒跑過」，scheduler 剛好在那一分鐘停著也會補跑。
 */
export function createScheduler(deps: SchedulerDeps) {
  let lastMinute = -1;
  let janitorDay = '';
  let pruneDay = '';
  return async function tick(now: number) {
    const minute = Math.round(now / MINUTE_MS);
    if (minute === lastMinute) return { skipped: true as const };
    lastMinute = minute;
    const slotMs = minute * MINUTE_MS;

    if (deps.dispatchEnabled) await safe('dispatch', () => deps.dispatchAt(slotMs));

    const today = taipeiIsoDate(slotMs);
    const mod = taipeiMinuteOfDay(slotMs);
    if (mod >= 4 * 60 && janitorDay !== today) {
      janitorDay = today;
      await safe('janitor', deps.runJanitor);
    }
    if (mod >= 4 * 60 + 10 && pruneDay !== today && deps.rawRetentionDays > 0) {
      pruneDay = today;
      await safe('prune-raw', () => deps.runPrune(slotMs));
    }
    return { skipped: false as const, minute };
  };
}

function main() {
  const dispatchEnabled = parseDispatchEnabled(env.DISPATCH_ENABLED);
  const rawRetentionDays = intEnv('RAW_RETENTION_DAYS', 3);
  const region = env.AWS_REGION || 'us-east-1';
  const endpoint = env.AWS_ENDPOINT_URL || undefined;
  const sqs = new SQSClient({ region, endpoint });
  const s3 = new S3Client({ region, endpoint, forcePathStyle: !!endpoint });

  const tick = createScheduler({
    dispatchEnabled,
    rawRetentionDays,
    dispatchAt: async (nowMs) => {
      const r = await dispatch(env, nowMs, sqsSendBatch(sqs));
      return { sent: r.sent, failed: r.failed };
    },
    runJanitor: () => janitor(),
    runPrune: (nowMs) => {
      if (!env.RAW_BUCKET) return Promise.resolve({ skipped: 'RAW_BUCKET 未設定' });
      return pruneRaw(s3, env.RAW_BUCKET, nowMs, rawRetentionDays);
    },
  });

  const scheduleNext = () => {
    const delay = MINUTE_MS - (Date.now() % MINUTE_MS);
    setTimeout(async () => {
      await tick(Date.now());
      scheduleNext();
    }, delay);
  };

  log('info', 'scheduler started', { dispatchEnabled, rawRetentionDays });
  scheduleNext();

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      log('info', `received ${sig}, exiting`);
      process.exit(0);
    });
  }
}

// 測試時只 import 函式，不啟動排程
if (env.SCHEDULER_NO_MAIN !== '1') {
  try {
    main();
  } catch (e) {
    log('error', 'scheduler config error', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}
