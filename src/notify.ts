/**
 * 釋位推播。
 *
 * 只推 `released`（額滿 → 有位）—— 那是退考釋出的那一刻，也是唯一值得搶的時機。
 * `increased`（本來就有位、數量變多）和 `new`（新開場次）不推，否則熱門站一天
 * 會轟你幾十則，然後你就會關掉通知。
 *
 * 兩個預算要顧：
 *   - Workers 免費方案單次 50 個 subrequest，抓取已用掉 14，所以推播上限 MAX_SENDS。
 *   - 每個訂閱一則訊息（多個場次合併在同一則），而不是每個場次一則。
 */
import { STATION_BY_NO, LICENSE_BY_CODE } from './catalogue.ts';

const MAX_SENDS = 5;
/** Discord embed 最多 25 個 field，實務上超過 10 個就該收斂成摘要 */
const MAX_LINES = 10;

export type ReleasedEvent = {
  licenseType: string;
  dmvNo: string;
  examDate: string;
  secKey: string;
  newQuota: number | null;
};

type Sub = { id: number; kind: string; target: string; label: string | null };

const SIGNUP_URL = 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations';

/** 載入啟用中的訂閱與它們的追蹤清單，固定 2 個查詢 */
async function loadSubs(db: D1Database): Promise<Array<Sub & { watches: Set<string> }>> {
  const subs = await db
    .prepare('SELECT id, kind, target, label FROM subscription WHERE active = 1')
    .all<Sub>();
  const list = subs.results ?? [];
  if (!list.length) return [];

  const w = await db
    .prepare('SELECT subscription_id, license_type, dmv_no FROM subscription_watch')
    .all<{ subscription_id: number; license_type: string; dmv_no: string }>();

  const byId = new Map<number, Set<string>>();
  for (const row of w.results ?? []) {
    if (!byId.has(row.subscription_id)) byId.set(row.subscription_id, new Set());
    byId.get(row.subscription_id)!.add(`${row.license_type}|${row.dmv_no}`);
  }
  return list.map((s) => ({ ...s, watches: byId.get(s.id) ?? new Set<string>() }));
}

function describe(e: ReleasedEvent): string {
  const st = STATION_BY_NO.get(e.dmvNo);
  const lt = LICENSE_BY_CODE.get(e.licenseType);
  const [, m, d] = e.examDate.split('-');
  return `**${st?.name ?? e.dmvNo}** · ${lt?.name ?? e.licenseType} · ${Number(m)}/${Number(d)} · 釋出 ${e.newQuota} 位`;
}

function buildDiscordBody(events: ReleasedEvent[], label: string | null) {
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
        footer: { text: label ? `${label} · 名額隨時會被搶走，請盡快至官網報名` : '名額隨時會被搶走，請盡快至官網報名' },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function sendDiscord(target: string, body: string): Promise<string | null> {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (res.ok || res.status === 204) return null;
  return `HTTP ${res.status}`;
}

/**
 * 針對這輪掃到的釋位事件送出推播。
 * 回傳要併進主 batch 的 statement（不要在這裡自己寫 D1，會吃掉查詢預算）。
 */
export async function notifyReleased(
  db: D1Database,
  released: ReleasedEvent[],
  now: number,
): Promise<{ stmts: D1PreparedStatement[]; sent: number; failed: number }> {
  if (!released.length) return { stmts: [], sent: 0, failed: 0 };

  const subs = await loadSubs(db);
  if (!subs.length) return { stmts: [], sent: 0, failed: 0 };

  const jobs: Array<{ sub: Sub; events: ReleasedEvent[] }> = [];
  for (const s of subs) {
    // 追蹤清單是空的就代表全部都要
    const mine = s.watches.size
      ? released.filter((e) => s.watches.has(`${e.licenseType}|${e.dmvNo}`))
      : released;
    if (mine.length) jobs.push({ sub: s, events: mine });
  }

  const stmts: D1PreparedStatement[] = [];
  let sent = 0;
  let failed = 0;

  for (const job of jobs.slice(0, MAX_SENDS)) {
    let err: string | null = null;
    try {
      err = await sendDiscord(job.sub.target, buildDiscordBody(job.events, job.sub.label));
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    if (err) failed++;
    else sent++;
    stmts.push(
      db
        .prepare('UPDATE subscription SET last_sent_at = ?, last_error = ? WHERE id = ?')
        .bind(err ? null : now, err, job.sub.id),
    );
  }
  return { stmts, sent, failed };
}
