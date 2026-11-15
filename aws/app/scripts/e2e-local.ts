/**
 * 本機端到端驗證：docker compose（Postgres + LocalStack）上跑一次完整鏈路，
 * 而且跑的是 `npm run build` 打包出來的產物，不是原始碼：
 *
 *   dist/dispatcher.zip → SQS → dist/worker.mjs（子行程）→ Postgres
 *                                         ├→ S3 raw/、events/
 *                                         └→ SNS → （filter policy target=live）→ 觀察用 SQS
 *                                                                             → dist/notifier.zip → 假 Discord
 *
 * 監理站與 Discord 都是這支腳本自己起的本機 HTTP server，**完全不會打官網**：
 * MVDIS_BASE_URL 指向 127.0.0.1，腳本開頭也會再檢查一次。
 *
 * 用法（在 aws/app）：
 *   docker compose -p mvdis-worker -f ../docker-compose.yml up -d
 *   npm run build && npm run e2e:local
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import pg from 'pg';
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { CreateSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CreateTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { locationsHtml, daysFromNow } from '../test/helpers/fixture.ts';
import type { ScanTask } from '../../shared/contracts.ts';
import { migrate } from './migrate.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://mvdis:mvdis@localhost:5432/mvdis';
const REGION = 'us-east-1';
const awsEnv = {
  AWS_REGION: REGION,
  AWS_ENDPOINT_URL: ENDPOINT,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
};
Object.assign(process.env, awsEnv);

const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
function check(name: string, ok: boolean, detail?: unknown) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

function assertLocal(url: string, what: string) {
  const h = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(h)) {
    throw new Error(`${what} 必須指向本機（目前是 ${h}），e2e 會清空資料表、也不能打外部網站`);
  }
}

/** 讀 build.mjs 產生的單檔 zip（只有一個 deflate 的 index.mjs） */
async function loadLambda(name: string, dir: string) {
  const buf = await readFile(join(root, 'dist', `${name}.zip`));
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${name}.zip 格式不對`);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const fileName = buf.subarray(30, 30 + nameLen).toString();
  if (fileName !== 'index.mjs') throw new Error(`${name}.zip 的入口應為 index.mjs，實際是 ${fileName}`);
  const data = inflateRawSync(buf.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + compSize));
  const out = join(dir, `${name}.mjs`);
  await writeFile(out, data);
  return (await import(pathToFileURL(out).href)) as { handler: (e?: unknown) => Promise<unknown> };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assertLocal(DATABASE_URL, 'DATABASE_URL');
  assertLocal(ENDPOINT, 'AWS_ENDPOINT_URL');

  // === 假監理站 + 假 Discord ===
  // 每個組合第奇數次被查是「上午場額滿」，第偶數次變成「有 2 位」→ 產生 released
  const hits = new Map<string, number>();
  const discordPosts: Array<Record<string, any>> = [];
  const D1 = daysFromNow(10);
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.method === 'POST' && req.url === '/m3-emv-trn/exm/locations') {
      const f = new URLSearchParams(body);
      const k = `${f.get('licenseTypeCode')}|${f.get('dmvNo')}`;
      const n = (hits.get(k) ?? 0) + 1;
      hits.set(k, n);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        locationsHtml([
          { date: D1, session: '上午', group: 1, quota: n % 2 === 1 ? 'full' : 2 },
          { date: D1, session: '下午', group: 2, quota: 5 },
        ]),
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/webhook') {
      discordPosts.push(JSON.parse(body));
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const fakeBase = `http://127.0.0.1:${port}`;
  assertLocal(fakeBase, 'MVDIS_BASE_URL');

  // === 資料庫 ===
  await migrate({ DATABASE_URL });
  check('npm run migrate 的 migrate() 對 compose 的 Postgres 套用成功', true);
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  await db.query('TRUNCATE slot, slot_event, scan_log, scan_task_log');

  // === LocalStack 資源（每次用新名字，不互相干擾）===
  const suffix = Date.now().toString(36);
  const sqs = new SQSClient({ region: REGION, endpoint: ENDPOINT });
  const sns = new SNSClient({ region: REGION, endpoint: ENDPOINT });
  const s3 = new S3Client({ region: REGION, endpoint: ENDPOINT, forcePathStyle: true });
  const sm = new SecretsManagerClient({ region: REGION, endpoint: ENDPOINT });

  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `mvdis-scan-dlq-${suffix}` }));
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn;
  const scanQueueUrl = (
    await sqs.send(
      new CreateQueueCommand({
        QueueName: `mvdis-scan-${suffix}`,
        Attributes: {
          VisibilityTimeout: '60',
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 3 }),
        },
      }),
    )
  ).QueueUrl!;
  const topicArn = (await sns.send(new CreateTopicCommand({ Name: `mvdis-events-${suffix}` }))).TopicArn!;
  const bucket = `mvdis-raw-${suffix}`;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  // 觀察用：模擬 notifier 的訂閱（filter policy 只收 live；不開 raw delivery，收到 SNS 信封）
  const sinkUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `mvdis-notify-${suffix}` }))).QueueUrl!;
  const sinkArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: sinkUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes!.QueueArn!;
  await sns.send(
    new SubscribeCommand({
      TopicArn: topicArn,
      Protocol: 'sqs',
      Endpoint: sinkArn,
      Attributes: { FilterPolicy: JSON.stringify({ target: ['live'] }) },
    }),
  );
  const secretArn = (
    await sm.send(
      new CreateSecretCommand({
        Name: `mvdis/discord-${suffix}`,
        SecretString: JSON.stringify({ webhookUrl: `${fakeBase}/webhook` }),
      }),
    )
  ).ARN!;

  // === 載入打包產物 ===
  const tmp = await mkdtemp(join(tmpdir(), 'mvdis-e2e-'));
  const dispatcher = await loadLambda('dispatcher', tmp);
  const notifier = await loadLambda('notifier', tmp);

  // === worker 子行程（dist/worker.mjs）===
  const workerLines: string[] = [];
  const worker = spawn(process.execPath, [join(root, 'dist', 'worker.mjs')], {
    env: {
      ...process.env,
      ...awsEnv,
      DATABASE_URL,
      SCAN_QUEUE_URL: scanQueueUrl,
      EVENT_TOPIC_ARN: topicArn,
      RAW_BUCKET: bucket,
      MVDIS_BASE_URL: fakeBase,
      WORKER_CONCURRENCY: '5',
      WORKER_ID: 'e2e-worker',
      WORKER_AZ: 'local-1a',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  worker.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      workerLines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  worker.stderr.on('data', (d) => process.stderr.write(`[worker] ${d}`));

  const finishedCount = async () =>
    Number((await db.query('SELECT count(*)::int AS n FROM scan_task_log WHERE finished_at IS NOT NULL')).rows[0].n);
  const queueEmpty = async () => {
    const a = (
      await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: scanQueueUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      )
    ).Attributes!;
    return Number(a.ApproximateNumberOfMessages) + Number(a.ApproximateNumberOfMessagesNotVisible) === 0;
  };
  async function waitDrained(expectFinished: number, label: string) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if ((await finishedCount()) >= expectFinished && (await queueEmpty())) return;
      await sleep(1000);
    }
    throw new Error(`${label}：等不到佇列清空（finished=${await finishedCount()}，預期 ${expectFinished}）`);
  }

  try {
    // --- 第 1 輪：dispatcher（live，打假站）＋模擬 EventBridge 重複觸發 ---
    process.env.SCAN_QUEUE_URL = scanQueueUrl;
    process.env.SCAN_TARGET = 'live';
    const r1 = (await dispatcher.handler()) as { sent: number };
    const r1b = (await dispatcher.handler()) as { sent: number };
    check('dispatcher（dist/dispatcher.zip）live 模式每次送 14 則', r1.sent === 14 && r1b.sent === 14, [r1, r1b]);
    // 佇列清空 = 每則訊息都處理完才被刪。同一分鐘內兩次觸發 → 14 個 taskId；剛好跨分鐘 → 28 個
    await waitDrained(14, '第 1 輪');
    const round1 = await db.query<{ license_type: string; lv1: string; dmv_no: string; outcome: string }>(
      'SELECT license_type, dmv_no, outcome FROM scan_task_log',
    );
    check('第 1 輪：所有任務 outcome=ok，重複觸發的任務沒有重做', round1.rows.every((r) => r.outcome === 'ok'), {
      tasks: round1.rowCount,
      fakeSiteHits: [...hits.values()].reduce((a, b) => a + b, 0),
    });
    check(
      '第 1 輪：假監理站被查的次數 = 不重複的任務數（重複的 taskId 不會多打一次）',
      [...hits.values()].reduce((a, b) => a + b, 0) === round1.rowCount,
    );

    // --- 第 2 輪：同一批組合再掃一次（像 experiments 直接灌佇列），上午場由額滿變有位 → released ---
    const combos = round1.rows.map((r) => ({ licenseType: r.license_type, dmvNo: r.dmv_no }));
    const { STATION_BY_NO } = await import('../../../src/catalogue.ts');
    const mk = (c: { licenseType: string; dmvNo: string }, target: 'live' | 'replay', runId: string | null): ScanTask => ({
      v: 1,
      taskId: randomUUID(),
      licenseType: c.licenseType,
      lv1: STATION_BY_NO.get(c.dmvNo)!.lv1,
      dmvNo: c.dmvNo,
      tier: 'hot',
      target,
      runId,
      enqueuedAt: Date.now(),
    });
    async function enqueue(tasks: ScanTask[]) {
      for (let i = 0; i < tasks.length; i += 10) {
        await sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: scanQueueUrl,
            Entries: tasks.slice(i, i + 10).map((t, j) => ({ Id: String(j), MessageBody: JSON.stringify(t) })),
          }),
        );
      }
    }
    let total = round1.rowCount!;
    await enqueue(combos.map((c) => mk(c, 'live', null)));
    total += combos.length;
    await waitDrained(total, '第 2 輪');
    const rel = await db.query("SELECT count(*)::int AS n FROM slot_event WHERE kind = 'released'");
    check('第 2 輪：每個組合各記一筆 released', rel.rows[0].n === combos.length, { released: rel.rows[0].n });

    // --- 第 3、4 輪：replay 任務（runId=e2e-replay），released 會發到 SNS，但 filter policy 擋掉 ---
    const two = combos.slice(0, 2);
    await enqueue(two.map((c) => mk(c, 'replay', 'e2e-replay')));
    total += 2;
    await waitDrained(total, '第 3 輪');
    await enqueue(two.map((c) => mk(c, 'replay', 'e2e-replay')));
    total += 2;
    await waitDrained(total, '第 4 輪');
    const relReplay = await db.query(
      "SELECT count(*)::int AS n FROM slot_event WHERE kind = 'released' AND run_id = 'e2e-replay'",
    );
    check('第 3、4 輪：replay 任務的 released 帶 run_id', relReplay.rows[0].n === 2, relReplay.rows[0]);

    // --- 資料庫內容 ---
    const tl = await db.query(
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE worker_id = 'e2e-worker' AND az = 'local-1a')::int AS tagged FROM scan_task_log",
    );
    check('scan_task_log 每列都記了 worker_id 與 az', tl.rows[0].n === tl.rows[0].tagged, tl.rows[0]);
    const slots = await db.query('SELECT count(*)::int AS n FROM slot');
    check('slot：每個組合 2 個場次', slots.rows[0].n === combos.length * 2, slots.rows[0]);

    // --- S3 ---
    const list = async (prefix: string) =>
      (await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))).Contents ?? [];
    const raws = await list('raw/');
    const evs = await list('events/');
    check('S3 raw/：每次成功抓取一個 .html.gz', raws.length === total, { raw: raws.length, tasks: total });
    check('S3 events/：有事件的任務各一個 .jsonl', evs.length > 0 && evs.every((o) => o.Key!.endsWith('.jsonl')), {
      events: evs.length,
      sample: evs[0]?.Key,
    });

    // --- SNS → 觀察用 SQS（只該收到 live 的 released）---
    const sinkMsgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: sinkUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      sinkMsgs.push(...(r.Messages ?? []));
      for (const m of r.Messages ?? []) await sqs.send(new DeleteMessageCommand({ QueueUrl: sinkUrl, ReceiptHandle: m.ReceiptHandle }));
      if (sinkMsgs.length >= combos.length && !(r.Messages ?? []).length) break;
    }
    const sinkEvents = sinkMsgs.map((m) => JSON.parse(JSON.parse(m.Body!).Message));
    check(
      'SNS：live 的 released 逐筆送達，replay 的被 filter policy 擋掉',
      sinkEvents.length === combos.length && sinkEvents.every((e) => e.target === 'live' && e.kind === 'released'),
      { received: sinkEvents.length, expected: combos.length },
    );

    // --- notifier（dist/notifier.zip）：SQS 批次觸發 → 合併成一則 Discord ---
    process.env.DISCORD_SECRET_ARN = secretArn;
    const nr = (await notifier.handler({
      Records: sinkMsgs.map((m) => ({ eventSource: 'aws:sqs', body: m.Body })),
    })) as { sent: number; events: number };
    check('notifier：同一批釋位合併成 1 則 Discord 訊息', nr.sent === 1 && discordPosts.length === 1, {
      result: nr,
      title: discordPosts[0]?.embeds?.[0]?.title,
    });
    const nr2 = (await notifier.handler({
      Records: [{ Sns: { Message: JSON.stringify({ ...sinkEvents[0], target: 'replay' }), MessageAttributes: {} } }],
    })) as { sent: number };
    check('notifier：replay 事件不推播', nr2.sent === 0 && discordPosts.length === 1);

    // --- EMF ---
    const emf = workerLines.filter((l) => l.includes('"_aws"')).map((l) => JSON.parse(l));
    check(
      'worker 的 EMF 指標：每個實際抓取的任務一行，Namespace=MvdisWatch、維度 Tier/Target',
      emf.length === total &&
        emf.every((e) => e._aws.CloudWatchMetrics[0].Namespace === 'MvdisWatch' && e.Tier && e.Target),
      { lines: emf.length, sample: emf[0] && { Tier: emf[0].Tier, Target: emf[0].Target, ScanDurationMs: emf[0].ScanDurationMs } },
    );

    const dlqCount = Number(
      (
        await sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
        )
      ).Attributes!.ApproximateNumberOfMessages,
    );
    check('DLQ 是空的', dlqCount === 0, { dlq: dlqCount });
  } finally {
    worker.kill();
    server.close();
    await db.end();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 項通過`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
