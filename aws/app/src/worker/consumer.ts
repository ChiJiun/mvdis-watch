/**
 * SQS 長輪詢 consumer：同時最多處理 WORKER_CONCURRENCY 則，處理完（deleteMessage=true）才刪訊息。
 */
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { processMessage, type Deps, type ProcessResult } from './process.ts';

export type ConsumerOptions = {
  sqs: SQSClient;
  queueUrl: string;
  concurrency: number;
  deps: Deps;
  /** 長輪詢秒數，SQS 上限 20 */
  waitTimeSeconds?: number;
  /** 收到 abort 之後不再收新訊息，等手上的處理完才結束 */
  signal: AbortSignal;
  onResult?: (r: ProcessResult) => void;
};

export async function handleMessage(m: Message, opts: ConsumerOptions): Promise<void> {
  const { deps } = opts;
  const receiveCount = Number(m.Attributes?.ApproximateReceiveCount ?? '1') || 1;
  let r: ProcessResult;
  try {
    r = await processMessage(m.Body ?? '', receiveCount, deps);
  } catch (e) {
    // 基礎設施錯誤：不刪訊息，讓 SQS 重送
    deps.log({
      level: 'error',
      msg: 'process failed, message left for redelivery',
      messageId: m.MessageId,
      receiveCount,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  opts.onResult?.(r);
  deps.log({ level: r.outcome === 'error' || r.outcome === 'invalid' ? 'warn' : 'info', msg: 'task', ...r });
  if (r.deleteMessage) {
    await opts.sqs.send(new DeleteMessageCommand({ QueueUrl: opts.queueUrl, ReceiptHandle: m.ReceiptHandle }));
  }
}

export async function runConsumer(opts: ConsumerOptions): Promise<void> {
  const inflight = new Set<Promise<void>>();
  const concurrency = Math.max(1, opts.concurrency);

  while (!opts.signal.aborted) {
    const free = concurrency - inflight.size;
    if (free <= 0) {
      await Promise.race(inflight);
      continue;
    }
    let messages: Message[] = [];
    try {
      const res = await opts.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: opts.queueUrl,
          MaxNumberOfMessages: Math.min(10, free),
          WaitTimeSeconds: opts.waitTimeSeconds ?? 20,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
        { abortSignal: opts.signal },
      );
      messages = res.Messages ?? [];
    } catch (e) {
      if (opts.signal.aborted) break;
      opts.deps.log({ level: 'error', msg: 'receive failed', error: e instanceof Error ? e.message : String(e) });
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const m of messages) {
      const p: Promise<void> = handleMessage(m, opts)
        .catch((e) =>
          opts.deps.log({ level: 'error', msg: 'delete failed', error: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
  }
  await Promise.allSettled(inflight);
}
