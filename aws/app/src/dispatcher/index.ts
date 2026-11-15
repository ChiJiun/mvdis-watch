/**
 * dispatcher Lambda：EventBridge 每分鐘觸發一次，把這一輪的 ScanTask 送進 SQS。
 * 不放 VPC、不連資料庫（契約第 4 節）。
 */
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { ScanTask } from '../../../shared/contracts.ts';
import { awsEndpoint, awsRegion, required, type Env } from '../config.ts';
import { dispatchConfig, planTick } from './plan.ts';

let sqs: SQSClient | undefined;

function client(env: Env): SQSClient {
  sqs ??= new SQSClient({ region: awsRegion(env), endpoint: awsEndpoint(env) });
  return sqs;
}

export type SendBatch = (queueUrl: string, tasks: ScanTask[]) => Promise<{ failed: string[] }>;

export function sqsSendBatch(c: SQSClient): SendBatch {
  return async (queueUrl, tasks) => {
    const res = await c.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: tasks.map((t, i) => ({ Id: String(i), MessageBody: JSON.stringify(t) })),
      }),
    );
    return { failed: (res.Failed ?? []).map((f) => `${f.Id}:${f.Code}:${f.Message ?? ''}`) };
  };
}

/** 可注入的核心，測試用 */
export async function dispatch(env: Env, nowMs: number, send: SendBatch) {
  const queueUrl = required(env, 'SCAN_QUEUE_URL');
  const { config, warnings } = dispatchConfig(env);
  for (const w of warnings) console.warn(JSON.stringify({ level: 'warn', msg: w }));

  const tasks = planTick(nowMs, config);
  const failed: string[] = [];
  // SendMessageBatch 一次最多 10 則
  for (let i = 0; i < tasks.length; i += 10) {
    const r = await send(queueUrl, tasks.slice(i, i + 10));
    failed.push(...r.failed);
  }
  const summary = {
    level: failed.length ? 'error' : 'info',
    msg: 'dispatched',
    target: config.target,
    hot: tasks.filter((t) => t.tier === 'hot').length,
    cold: tasks.filter((t) => t.tier === 'cold').length,
    failed,
  };
  console.log(JSON.stringify(summary));
  // 部分失敗不重丟：重試整輪會把成功的那幾則再送一次（雖然 taskId 固定、worker 會擋掉，
  // 但沒必要）。漏掉的組合下一圈會再輪到。
  return { sent: tasks.length - failed.length, failed: failed.length, tasks };
}

export async function handler(): Promise<{ sent: number; failed: number }> {
  const env = process.env as Env;
  const r = await dispatch(env, Date.now(), sqsSendBatch(client(env)));
  return { sent: r.sent, failed: r.failed };
}
