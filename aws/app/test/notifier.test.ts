import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvents, notify } from '../src/notifier/index.ts';
import { buildDiscordBody } from '../src/notifier/format.ts';
import type { ReleasedEvent } from '../../shared/contracts.ts';

const ev = (over: Partial<ReleasedEvent> = {}): ReleasedEvent => ({
  licenseType: '3',
  dmvNo: '63',
  examDate: '2026-12-01',
  secKey: '1:1',
  kind: 'released',
  oldQuota: -1,
  newQuota: 2,
  at: 1794761624526,
  taskId: '0b8a5c1e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
  runId: null,
  target: 'live',
  ...over,
});

const snsRecord = (e: ReleasedEvent) => ({
  Sns: { Message: JSON.stringify(e), MessageAttributes: { target: { Type: 'String', Value: e.target } } },
});

test('extractEvents：SNS 直接觸發', () => {
  const out = extractEvents({ Records: [snsRecord(ev())] } as never);
  assert.equal(out.length, 1);
  assert.equal(out[0].dmvNo, '63');
});

test('extractEvents：SQS（SNS 信封與 raw delivery）都能解析，多筆合併、重複的去掉', () => {
  const a = ev({ secKey: '1:1' });
  const b = ev({ secKey: '2:1', dmvNo: '61', lv1: undefined } as never);
  const envelope = {
    Type: 'Notification',
    Message: JSON.stringify(a),
    MessageAttributes: { target: { Type: 'String', Value: 'live' } },
  };
  const out = extractEvents({
    Records: [
      { body: JSON.stringify(envelope) },
      { body: JSON.stringify(b), messageAttributes: { target: { stringValue: 'live' } } },
      { body: JSON.stringify(envelope) }, // SNS 至少一次送達的重複
    ],
  } as never);
  assert.equal(out.length, 2);
});

test('extractEvents：replay 事件與非 released 一律丟掉', () => {
  const out = extractEvents({
    Records: [snsRecord(ev({ target: 'replay' })), snsRecord({ ...ev(), kind: 'increased' } as never), { Sns: { Message: 'garbage' } }],
  } as never);
  assert.equal(out.length, 0);
});

test('notify：同一批事件合併成一則 Discord 訊息', async () => {
  const posts: string[] = [];
  const fake = (async (_u: string | URL | Request, init?: RequestInit) => {
    posts.push(String(init?.body));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const r = await notify(
    { Records: [snsRecord(ev({ secKey: '1:1' })), snsRecord(ev({ secKey: '2:1', examDate: '2026-12-02' }))] } as never,
    { webhookUrl: async () => 'https://discord.example/webhook', fetchFn: fake, now: () => new Date(0) },
  );
  assert.deepEqual(r, { sent: 1, events: 2 });
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0]);
  assert.equal(body.embeds[0].title, '🛵 2 個場次釋出');
  assert.match(body.embeds[0].description, /豐原監理站.*普通重型機車.*12\/1.*釋出 2 位/);
});

test('notify：沒有可推的事件就不打 webhook、也不讀 secret', async () => {
  let secretReads = 0;
  const r = await notify({ Records: [snsRecord(ev({ target: 'replay' }))] } as never, {
    webhookUrl: async () => {
      secretReads++;
      return 'x';
    },
    fetchFn: (async () => {
      throw new Error('不該被呼叫');
    }) as typeof fetch,
    now: () => new Date(0),
  });
  assert.deepEqual(r, { sent: 0, events: 0 });
  assert.equal(secretReads, 0);
});

test('notify：Discord 回錯誤時丟例外，讓 Lambda 重試', async () => {
  await assert.rejects(
    notify({ Records: [snsRecord(ev())] } as never, {
      webhookUrl: async () => 'x',
      fetchFn: (async () => new Response('rate limited', { status: 429 })) as typeof fetch,
      now: () => new Date(0),
    }),
    /429/,
  );
});

test('buildDiscordBody：超過 10 筆收斂成摘要', () => {
  const events = Array.from({ length: 13 }, (_, i) => ev({ secKey: `1:${i}` }));
  const body = JSON.parse(buildDiscordBody(events, new Date(0)));
  assert.equal(body.embeds[0].title, '🛵 13 個場次釋出');
  assert.match(body.embeds[0].description, /…另外 3 個場次$/);
});
