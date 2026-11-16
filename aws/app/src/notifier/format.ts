/**
 * Discord 訊息格式，沿用原型 src/notify.ts 的樣式：同一批事件合併成一則 embed。
 */
import { LICENSE_BY_CODE, STATION_BY_NO } from '../../../../src/catalogue.ts';
import type { ReleasedEvent } from '../../../shared/contracts.ts';

/** Discord embed description 上限 4096 字；超過 10 行就收斂成摘要 */
export const MAX_LINES = 10;
const SIGNUP_URL = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';

export function describe(e: ReleasedEvent): string {
  const st = STATION_BY_NO.get(e.dmvNo);
  const lt = LICENSE_BY_CODE.get(e.licenseType);
  const [, m, d] = e.examDate.split('-');
  return `**${st?.name ?? e.dmvNo}** · ${lt?.name ?? e.licenseType} · ${Number(m)}/${Number(d)} · 釋出 ${e.newQuota} 位`;
}

/** 同一個場次重複出現（SNS 至少送達一次）只留一筆 */
export function dedupe(events: ReleasedEvent[]): ReleasedEvent[] {
  const seen = new Map<string, ReleasedEvent>();
  for (const e of events) {
    const k = `${e.licenseType}|${e.dmvNo}|${e.examDate}|${e.secKey}|${e.at}`;
    if (!seen.has(k)) seen.set(k, e);
  }
  return [...seen.values()].sort(
    (a, b) => a.examDate.localeCompare(b.examDate) || a.dmvNo.localeCompare(b.dmvNo) || a.secKey.localeCompare(b.secKey),
  );
}

export function buildDiscordBody(events: ReleasedEvent[], now = new Date()): string {
  const shown = events.slice(0, MAX_LINES);
  const rest = events.length - shown.length;
  const lines = shown.map((e) => `• ${describe(e)}`);
  if (rest > 0) lines.push(`…另外 ${rest} 個場次`);
  return JSON.stringify({
    username: '監理站餘額監測',
    embeds: [
      {
        title: `🛵 ${events.length} 個場次釋出`,
        description: lines.join('\n'),
        color: 0x0a7d4d,
        url: SIGNUP_URL,
        footer: { text: '名額隨時會被搶走，請盡快至官網報名' },
        timestamp: now.toISOString(),
      },
    ],
  });
}
