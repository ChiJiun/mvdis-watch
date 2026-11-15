/**
 * notifier Lambda：收 SNS `mvdis-events` 的 ReleasedEvent，合併成一則 Discord 訊息推播。
 *
 * 同時接受兩種觸發來源，讓 infra 可以自由選：
 *   - SNS 直接觸發：每次呼叫通常只有 1 筆 Record（SNS → Lambda 不會批次）
 *   - SNS → SQS → Lambda（設 batching window）：一次呼叫多筆，才真的能「同一批合併成一則」
 *     SQS body 可以是 SNS 信封（未開 raw delivery）或 ReleasedEvent 本身（raw delivery）
 *
 * 只推 target = live；filter policy 應該已經擋掉 replay，這裡再擋一次。
 */
import type { SNSEvent, SQSEvent } from 'aws-lambda';
import type { ReleasedEvent } from '../../../shared/contracts.ts';
import { required, type Env } from '../config.ts';
import { getSecretJson } from '../secrets.ts';
import { buildDiscordBody, dedupe } from './format.ts';

type AnyEvent = Partial<SNSEvent> & Partial<SQSEvent>;

function parseReleased(raw: string, attrTarget: string | undefined): ReleasedEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  // SQS 收到未開 raw delivery 的 SNS 信封
  if (rec.Type === 'Notification' && typeof rec.Message === 'string') {
    const attrs = rec.MessageAttributes as Record<string, { Value?: string }> | undefined;
    return parseReleased(rec.Message, attrs?.target?.Value ?? attrTarget);
  }
  if (rec.kind !== 'released' || typeof rec.dmvNo !== 'string' || typeof rec.examDate !== 'string') return null;
  const e = rec as unknown as ReleasedEvent;
  const target = e.target ?? attrTarget;
  if (target !== 'live') return null;
  return { ...e, target };
}

export function extractEvents(event: AnyEvent): ReleasedEvent[] {
  const out: ReleasedEvent[] = [];
  for (const r of (event.Records ?? []) as Array<Record<string, any>>) {
    let e: ReleasedEvent | null = null;
    if (r.Sns) {
      e = parseReleased(r.Sns.Message, r.Sns.MessageAttributes?.target?.Value);
    } else if (typeof r.body === 'string') {
      e = parseReleased(r.body, r.messageAttributes?.target?.stringValue);
    }
    if (e) out.push(e);
  }
  return dedupe(out);
}

let cachedWebhook: string | undefined;

export async function getWebhookUrl(env: Env): Promise<string> {
  if (cachedWebhook) return cachedWebhook;
  const s = await getSecretJson<{ webhookUrl: string }>(env, required(env, 'DISCORD_SECRET_ARN'));
  if (!s.webhookUrl) throw new Error('Discord secret 缺少 webhookUrl');
  cachedWebhook = s.webhookUrl;
  return cachedWebhook;
}

export type NotifyDeps = { webhookUrl: () => Promise<string>; fetchFn: typeof fetch; now: () => Date };

export async function notify(event: AnyEvent, deps: NotifyDeps): Promise<{ sent: number; events: number }> {
  const events = extractEvents(event);
  if (!events.length) return { sent: 0, events: 0 };
  const res = await deps.fetchFn(await deps.webhookUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: buildDiscordBody(events, deps.now()),
  });
  if (!res.ok) {
    // 丟例外讓 Lambda 重試（SNS 非同步呼叫會重試兩次；SQS 觸發則回到佇列）
    throw new Error(`Discord webhook HTTP ${res.status}`);
  }
  console.log(JSON.stringify({ level: 'info', msg: 'notified', events: events.length }));
  return { sent: 1, events: events.length };
}

export async function handler(event: AnyEvent) {
  const env = process.env as Env;
  return notify(event, { webhookUrl: () => getWebhookUrl(env), fetchFn: fetch, now: () => new Date() });
}
