/**
 * consumer 的刪訊息：receipt handle 失效（處理超過可見性逾時、訊息已被別台收走）時不能讓 worker 出錯。
 * 用格式錯誤的訊息走「直接刪」的路徑，不需要資料庫。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { handleMessage, type ConsumerOptions } from '../src/worker/consumer.ts';
import type { Deps } from '../src/worker/process.ts';

function setup(sendImpl: () => Promise<unknown>) {
  const logs: Array<Record<string, unknown>> = [];
  const sent: unknown[] = [];
  const sqs = {
    send: async (cmd: unknown) => {
      sent.push(cmd);
      return sendImpl();
    },
  } as unknown as SQSClient;
  const opts: ConsumerOptions = {
    sqs,
    queueUrl: 'http://sqs.local/q',
    concurrency: 1,
    deps: { log: (o: Record<string, unknown>) => logs.push(o) } as unknown as Deps,
    signal: new AbortController().signal,
  };
  return { opts, logs, sent };
}

const msg = { MessageId: 'm-1', ReceiptHandle: 'rh-old', Body: 'not json', Attributes: { ApproximateReceiveCount: '2' } };

test('DeleteMessage 回 ReceiptHandleIsInvalid：只記 warn，不丟例外', async () => {
  const { opts, logs, sent } = setup(async () => {
    throw Object.assign(new Error('The receipt handle has expired.'), { name: 'ReceiptHandleIsInvalid' });
  });
  await handleMessage(msg, opts);
  assert.equal(sent.length, 1, '有嘗試刪除');
  const l = logs.find((x) => String(x.msg).includes('receipt handle'));
  assert.equal(l?.level, 'warn');
});

test('其他 DeleteMessage 錯誤：記 error，也不丟例外（訊息會重送，走冪等路徑）', async () => {
  const { opts, logs } = setup(async () => {
    throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
  });
  await handleMessage(msg, opts);
  assert.equal(logs.find((x) => x.msg === 'delete failed')?.level, 'error');
});

test('刪除成功時不記錯誤', async () => {
  const { opts, logs, sent } = setup(async () => ({}));
  await handleMessage(msg, opts);
  assert.equal(sent.length, 1);
  assert.ok(!logs.some((x) => x.msg === 'delete failed' || String(x.msg).includes('receipt handle')));
});
