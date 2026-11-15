/**
 * 爬蟲 worker 進入點（EC2 上由 systemd 執行 dist/worker.mjs）。
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PublishBatchCommand, SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { ReleasedEvent } from '../../../shared/contracts.ts';
import { awsEndpoint, awsRegion, intOr, required, type Env } from '../config.ts';
import { createPool } from '../db.ts';
import { runConsumer } from './consumer.ts';
import { detectIdentity } from './instance.ts';
import { stdoutSink } from './metrics.ts';
import type { Deps } from './process.ts';

export function s3Putter(s3: S3Client, bucket: string): Deps['putObject'] {
  return async (key, body, contentType, contentEncoding) => {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentEncoding: contentEncoding,
      }),
    );
  };
}

/** 每個 released 事件各自是一則 SNS 訊息（契約第 6 節），用 PublishBatch 一次送最多 10 則 */
export function snsPublisher(sns: SNSClient, topicArn: string): Deps['publishReleased'] {
  return async (events: ReleasedEvent[]) => {
    for (let i = 0; i < events.length; i += 10) {
      const part = events.slice(i, i + 10);
      const res = await sns.send(
        new PublishBatchCommand({
          TopicArn: topicArn,
          PublishBatchRequestEntries: part.map((e, j) => ({
            Id: String(j),
            Message: JSON.stringify(e),
            MessageAttributes: { target: { DataType: 'String', StringValue: e.target } },
          })),
        }),
      );
      if (res.Failed?.length) {
        throw new Error(`SNS PublishBatch 失敗 ${res.Failed.length} 則：${res.Failed.map((f) => f.Code).join(',')}`);
      }
    }
  };
}

export async function main(env: Env = process.env as Env) {
  const region = awsRegion(env);
  const endpoint = awsEndpoint(env);
  const concurrency = Math.max(1, intOr(env.WORKER_CONCURRENCY, 5));
  const queueUrl = required(env, 'SCAN_QUEUE_URL');

  const pool = await createPool(env, concurrency + 1);
  const identity = await detectIdentity(env);
  const sqs = new SQSClient({ region, endpoint });
  const s3 = new S3Client({ region, endpoint, forcePathStyle: !!endpoint });
  const sns = new SNSClient({ region, endpoint });

  const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: Date.now(), ...o }));
  const deps: Deps = {
    pool,
    fetchFn: fetch,
    putObject: s3Putter(s3, required(env, 'RAW_BUCKET')),
    publishReleased: snsPublisher(sns, required(env, 'EVENT_TOPIC_ARN')),
    metrics: stdoutSink,
    log,
    identity,
    urls: { liveUrl: env.MVDIS_LIVE_URL || undefined, replayUrl: env.REPLAY_BASE_URL || undefined },
    fetchTimeoutMs: intOr(env.FETCH_TIMEOUT_MS, 20_000),
    now: Date.now,
  };

  const ac = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      log({ level: 'info', msg: `收到 ${sig}，處理完手上的訊息後結束` });
      ac.abort();
    });
  }

  log({ level: 'info', msg: 'worker started', ...identity, concurrency, ...deps.urls });
  await runConsumer({ sqs, queueUrl, concurrency, deps, signal: ac.signal });
  await pool.end();
  log({ level: 'info', msg: 'worker stopped' });
}

// 只有直接執行（node dist/worker.mjs 或 npm run worker）時才啟動
const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (/(worker\.mjs|worker\/main\.ts)$/.test(entry)) {
  main().catch((e) => {
    console.error(JSON.stringify({ level: 'fatal', msg: 'worker crashed', error: e instanceof Error ? e.stack : String(e) }));
    process.exit(1);
  });
}
