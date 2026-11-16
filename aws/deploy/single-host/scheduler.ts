/**
 * 單機部署用的排程器：取代 AWS 上的 EventBridge。
 *   - 每分鐘的第 0 秒呼叫 dispatcher（和 Lambda 版同一份 handler）
 *   - 每天台灣時間 04:00 呼叫 janitor（契約 §7）
 *   - 每天台灣時間 04:10 刪掉 RAW_RETENTION_DAYS 天前的 S3 raw/ 物件
 *     （LocalStack 的 S3 把小物件放在記憶體，不清會一直長；AWS 版靠 S3 lifecycle，不需要這段）
 *
 * 環境變數和 dispatcher／janitor 相同（見 aws/CONTRACTS.md §3），另外：
 *   RAW_RETENTION_DAYS：raw/ 保留天數，預設 3；設 0 表示不清。
 *   DISPATCH_ENABLED：設成 0 就不送任何任務（只跑 janitor），預設 1。
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { handler as dispatch } from '../../app/src/dispatcher/index.ts';
import { handler as janitor } from '../../app/src/janitor/index.ts';
import { taipeiIsoDate } from '../../shared/contracts.ts';

const env = process.env;
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

const dispatchEnabled = env.DISPATCH_ENABLED !== '0';
const rawRetentionDays = intEnv('RAW_RETENTION_DAYS', 3);

/** 刪掉 dt 分區早於 (台灣今天 - days) 的 raw/ 物件；鍵格式見 contracts.ts 的 s3Keys.raw */
export async function pruneRaw(s3: S3Client, bucket: string, now: number, days: number) {
  const cutoff = taipeiIsoDate(now - days * 24 * 3600 * 1000);
  let deleted = 0;
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
      await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }),
      );
      deleted += chunk.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { deleted, cutoff };
}

async function safe(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    log('info', `${name} ok`, { result: r });
  } catch (e) {
    log('error', `${name} failed`, { error: e instanceof Error ? e.message : String(e) });
  }
}

let lastDaily = '';

async function tick() {
  const now = Date.now();
  if (dispatchEnabled) await safe('dispatch', () => dispatch());

  // 台灣時間的時與分
  const t = new Date(now + TAIPEI_OFFSET_MS);
  const hh = t.getUTCHours();
  const mm = t.getUTCMinutes();
  const today = taipeiIsoDate(now);
  if (hh === 4 && mm === 0 && lastDaily !== `${today}-janitor`) {
    lastDaily = `${today}-janitor`;
    await safe('janitor', () => janitor());
  }
  if (hh === 4 && mm === 10 && rawRetentionDays > 0 && env.RAW_BUCKET) {
    const s3 = new S3Client({
      region: env.AWS_REGION || 'us-east-1',
      endpoint: env.AWS_ENDPOINT_URL || undefined,
      forcePathStyle: !!env.AWS_ENDPOINT_URL,
    });
    await safe('prune-raw', () => pruneRaw(s3, env.RAW_BUCKET!, now, rawRetentionDays));
  }
}

function scheduleNext() {
  // 對齊到下一個整分鐘
  const delay = 60_000 - (Date.now() % 60_000);
  setTimeout(async () => {
    await tick();
    scheduleNext();
  }, delay);
}

log('info', 'scheduler started', { dispatchEnabled, rawRetentionDays });
scheduleNext();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log('info', `received ${sig}, exiting`);
    process.exit(0);
  });
}
