/**
 * 單機部署用的排程器：取代 AWS 上的 EventBridge。
 *   - 每分鐘呼叫一次 dispatcher（和 Lambda 版同一份核心 `dispatch()`）；掃描佇列還有積壓時跳過這一輪
 *   - 每天台灣時間 04:00 之後第一次 tick 呼叫 janitor（契約 §7）
 *   - 每天台灣時間 04:10 之後第一次 tick 刪掉 RAW_RETENTION_DAYS 天前的 S3 raw/ 與 events/ 物件
 *     （LocalStack 的 S3 把小物件放在記憶體，不清會一直長；AWS 版靠 S3 lifecycle，不需要這段）
 *
 * 環境變數和 dispatcher／janitor 相同（見 aws/CONTRACTS.md §3），另外：
 *   DISPATCH_ENABLED：只接受 0 或 1，其他值啟動時直接報錯結束，避免誤開 live 派送。
 *   RAW_RETENTION_DAYS：raw/、events/ 保留天數，預設 3；設 0 表示不清。
 *
 * 一台主機只能跑一個 scheduler（不要 --scale），否則每分鐘的官網請求會加倍。
 *
 * 為什麼要檢查積壓：live 任務排隊 120 秒內都算新鮮（契約 §4.2），佇列裡最多可以同時有兩批沒過期的任務。
 * worker 停了超過一分鐘再恢復時，兩批會在同一分鐘內一起抓（28 次）。所以：
 *   1. 佇列有任何訊息（含處理中）就不派送 → 佇列裡最多只有一批。
 *   2. 而且要「連續兩個 tick 都看到佇列是空的」才派送。積壓的那批可能在下一個 tick 前幾秒才抓完，
 *      如果一看到空就派送，前後兩批會在幾秒內接連抓 28 次。看到空代表上一批已經全部抓完
 *      （處理中的訊息也算在積壓裡），再等一個 tick，兩批之間就至少隔 60 秒。
 *   正常運作時每批幾秒內就處理完，每個 tick 派送前看到的都是空佇列，不受影響；
 *   scheduler 剛啟動或積壓剛清空時會多等一分鐘。
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { dispatch, sqsSendBatch } from '../../app/src/dispatcher/index.ts';
import { handler as janitor } from '../../app/src/janitor/index.ts';
import { taipeiIsoDate } from '../../shared/contracts.ts';

const env = process.env;
const MINUTE_MS = 60_000;
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;
/** 單一步驟的上限；超過就放棄這一步，確保 scheduleNext 一定會排下一輪 */
const STEP_TIMEOUT_MS = 45_000;
/** 要定期清除的 S3 前綴；鍵格式都是 `<prefix>dt=YYYY-MM-DD/...`（contracts.ts 的 s3Keys） */
export const PRUNE_PREFIXES = ['raw/', 'events/'] as const;
const BACKLOG_ATTRS = [
  'ApproximateNumberOfMessages',
  'ApproximateNumberOfMessagesNotVisible',
  'ApproximateNumberOfMessagesDelayed',
] as const;

function log(level: 'info' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, msg, at: new Date().toISOString(), ...extra }));
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
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

/** 掃描佇列裡還沒處理完的訊息數（可見＋處理中＋延遲）；任一屬性讀不到就丟例外 */
export async function queueBacklog(sqs: SQSClient, queueUrl: string): Promise<number> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: [...BACKLOG_ATTRS] }),
  );
  const a = res.Attributes ?? {};
  let total = 0;
  for (const k of BACKLOG_ATTRS) {
    const n = Number(a[k]);
    if (a[k] === undefined || !Number.isInteger(n) || n < 0) {
      throw new Error(`佇列屬性 ${k} 無法解析：${JSON.stringify(a[k] ?? null)}`);
    }
    total += n;
  }
  return total;
}

/** 刪掉 prefix 底下 dt 分區早於 (台灣今天 - days) 的物件；prefix 只能是 PRUNE_PREFIXES 之一 */
export async function pruneRaw(
  s3: S3Client,
  bucket: string,
  now: number,
  days: number,
  prefix: (typeof PRUNE_PREFIXES)[number] = 'raw/',
) {
  const cutoff = taipeiIsoDate(now - days * 24 * 3600 * 1000);
  const re = new RegExp(`^${prefix}dt=(\\d{4}-\\d{2}-\\d{2})/`);
  let deleted = 0;
  const failed: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const old = (page.Contents ?? [])
      .map((o) => o.Key!)
      .filter((k) => {
        const m = re.exec(k);
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
  return { prefix, deleted, failed: failed.slice(0, 20), failedCount: failed.length, cutoff };
}

/** 台灣時間的「當天第幾分鐘」 */
function taipeiMinuteOfDay(now: number): number {
  const t = new Date(now + TAIPEI_OFFSET_MS);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} 超過 ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

async function safe(name: string, fn: () => Promise<unknown>, timeoutMs: number) {
  try {
    const r = await withTimeout(fn(), timeoutMs, name);
    log('info', `${name} ok`, { result: r });
  } catch (e) {
    log('error', `${name} failed`, { error: errMsg(e) });
  }
}

export type SchedulerDeps = {
  dispatchEnabled: boolean;
  rawRetentionDays: number;
  /** 掃描佇列的積壓數；丟例外時視為無法確認，這一輪不派送 */
  backlog: () => Promise<number>;
  dispatchAt: (nowMs: number) => Promise<unknown>;
  runJanitor: () => Promise<unknown>;
  runPrune: (nowMs: number) => Promise<unknown>;
  stepTimeoutMs?: number;
};

/**
 * 一個 tick 的狀態機。`now` 可以早於或晚於整分鐘幾毫秒（libuv timer 和 Date.now() 有落差），
 * 所以用四捨五入取「這一輪是哪一分鐘」，同一分鐘只派送一次。
 * 派送前先確認掃描佇列是空的，而且上一個 tick 看到的也是空的；有積壓、查不到（fail-closed）、
 * 或剛從積壓恢復（冷卻一個 tick）都跳過。
 * janitor／prune 用「台灣時間過了 04:00／04:10、而且今天還沒跑過」，scheduler 剛好在那一分鐘停著也會補跑。
 */
export function createScheduler(deps: SchedulerDeps) {
  const timeoutMs = deps.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  let lastMinute = -1;
  /** 上一個 tick 是否確認佇列為空；啟動時當作不確定，先冷卻一個 tick */
  let prevEmpty = false;
  let janitorDay = '';
  let pruneDay = '';
  return async function tick(now: number) {
    const minute = Math.round(now / MINUTE_MS);
    if (minute === lastMinute) return { skipped: true as const };
    lastMinute = minute;
    const slotMs = minute * MINUTE_MS;

    let dispatched = false;
    if (deps.dispatchEnabled) {
      let backlog: number | undefined;
      try {
        backlog = await withTimeout(deps.backlog(), timeoutMs, 'backlog');
      } catch (e) {
        log('error', 'dispatch skipped: backlog unknown', { error: errMsg(e) });
      }
      const empty = backlog === 0;
      if (empty && prevEmpty) {
        dispatched = true;
        await safe('dispatch', () => deps.dispatchAt(slotMs), timeoutMs);
      } else if (empty) {
        log('info', 'dispatch skipped: cooldown', { reason: '上一個 tick 佇列不是空的或無法確認' });
      } else if (backlog !== undefined) {
        log('info', 'dispatch skipped: backlog', { backlog });
      }
      prevEmpty = empty;
    }

    const today = taipeiIsoDate(slotMs);
    const mod = taipeiMinuteOfDay(slotMs);
    if (mod >= 4 * 60 && janitorDay !== today) {
      janitorDay = today;
      await safe('janitor', deps.runJanitor, timeoutMs);
    }
    if (mod >= 4 * 60 + 10 && pruneDay !== today && deps.rawRetentionDays > 0) {
      pruneDay = today;
      await safe('prune-s3', () => deps.runPrune(slotMs), timeoutMs);
    }
    return { skipped: false as const, minute, dispatched };
  };
}

function main() {
  const dispatchEnabled = parseDispatchEnabled(env.DISPATCH_ENABLED);
  const rawRetentionDays = intEnv('RAW_RETENTION_DAYS', 3);
  const region = env.AWS_REGION || 'us-east-1';
  const endpoint = env.AWS_ENDPOINT_URL || undefined;
  // AWS SDK v3 預設沒有請求逾時；LocalStack 卡住時要讓請求失敗，而不是讓 scheduler 靜靜停住
  const requestHandler = { requestTimeout: 10_000, connectionTimeout: 3_000 };
  const sqs = new SQSClient({ region, endpoint, requestHandler });
  const s3 = new S3Client({ region, endpoint, forcePathStyle: !!endpoint, requestHandler });
  const queueUrl = env.SCAN_QUEUE_URL;
  if (dispatchEnabled && !queueUrl) throw new Error('DISPATCH_ENABLED=1 時必須設定 SCAN_QUEUE_URL');

  const tick = createScheduler({
    dispatchEnabled,
    rawRetentionDays,
    backlog: () => queueBacklog(sqs, queueUrl!),
    dispatchAt: async (nowMs) => {
      const r = await dispatch(env, nowMs, sqsSendBatch(sqs));
      return { sent: r.sent, failed: r.failed };
    },
    runJanitor: () => janitor(),
    runPrune: async (nowMs) => {
      if (!env.RAW_BUCKET) return { skipped: 'RAW_BUCKET 未設定' };
      const out = [];
      for (const p of PRUNE_PREFIXES) out.push(await pruneRaw(s3, env.RAW_BUCKET, nowMs, rawRetentionDays, p));
      return out;
    },
  });

  const scheduleNext = () => {
    const delay = MINUTE_MS - (Date.now() % MINUTE_MS);
    setTimeout(async () => {
      try {
        await tick(Date.now());
      } finally {
        scheduleNext();
      }
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
    log('error', 'scheduler config error', { error: errMsg(e) });
    process.exit(1);
  }
}
