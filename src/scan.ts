/**
 * 分層分片排程。
 *
 * 為什麼要分片：Workers 免費方案單次呼叫最多 50 個 subrequest、CPU 只有 10 ms，
 * 一次掃完 360 個組合是不可能的。所以 cron 每分鐘跑一次，每次只掃一小片。
 *
 * 為什麼要分層：熱門照類（機車、普通小型車）才是會被搶的，冷門的職業／大車／
 * 聯結車照類幾乎不會滿。實測 360 組中有 153 組根本沒有任何場次，
 * 全部同頻率掃是對政府網站的浪費。
 *
 *   熱門層 108 組（3/5/A × 36 站）  每 10 分鐘輪完一次
 *   冷門層 252 組（其餘 7 種照類）   每 2 小時輪完一次
 *   連續 5 次抓到空結果的組合會被降頻，每 24 小時才複查一次
 */
import { hotCombos, coldCombos, type Combo } from './catalogue.ts';
import { querySlots, mapLimit } from './mvdis.ts';
import { applySlots, getState, setStateStmt, scanLogStmt } from './db.ts';

export type Env = {
  DB: D1Database;
  HOT_PER_TICK?: string;
  COLD_PER_TICK?: string;
  FETCH_CONCURRENCY?: string;
};

const HOT = hotCombos();
const COLD = coldCombos();

const PRUNE_AFTER_EMPTY = 5;
const PRUNE_RECHECK_MS = 24 * 3600 * 1000;
const EVENT_RETENTION_MS = 30 * 24 * 3600 * 1000;

export function todayIso(now: Date = new Date()): string {
  const tw = new Date(now.getTime() + 8 * 3600 * 1000);
  return tw.toISOString().slice(0, 10);
}

const comboKey = (c: Combo) => `${c.licenseType}|${c.dmvNo}`;

/** 從游標往後取 n 個未被降頻的組合，回傳選中的組合與新游標 */
function take(list: Combo[], cursor: number, n: number, skip: Set<string>): { picked: Combo[]; cursor: number } {
  const picked: Combo[] = [];
  let i = cursor;
  // 最多走一整圈，避免全部被降頻時無限迴圈
  for (let steps = 0; steps < list.length && picked.length < n; steps++) {
    const c = list[i % list.length];
    i++;
    if (skip.has(comboKey(c))) continue;
    picked.push(c);
  }
  return { picked, cursor: i % list.length };
}

export async function runScanTick(env: Env, now = Date.now()) {
  const db = env.DB;
  const today = todayIso(new Date(now));
  const hotN = Number(env.HOT_PER_TICK ?? 11);
  const coldN = Number(env.COLD_PER_TICK ?? 3);
  const concurrency = Number(env.FETCH_CONCURRENCY ?? 5);

  // 只讀「最近查過而且一直是空的」組合，避免整張 scan_log 每分鐘都掃一次
  const prunedRes = await db
    .prepare('SELECT license_type, dmv_no FROM scan_log WHERE empty_streak >= ? AND last_ok > ?')
    .bind(PRUNE_AFTER_EMPTY, now - PRUNE_RECHECK_MS)
    .all<{ license_type: string; dmv_no: string }>();
  const skip = new Set((prunedRes.results ?? []).map((r) => `${r.license_type}|${r.dmv_no}`));

  const hotCursor = Number((await getState(db, 'hot_cursor')) ?? 0) || 0;
  const coldCursor = Number((await getState(db, 'cold_cursor')) ?? 0) || 0;

  const hot = take(HOT, hotCursor, hotN, skip);
  const cold = take(COLD, coldCursor, coldN, skip);
  const batch = [...hot.picked, ...cold.picked];

  let ok = 0;
  let failed = 0;
  let events = 0;
  let writes = 0;

  await mapLimit(batch, concurrency, async (c) => {
    const t0 = Date.now();
    try {
      const slots = await querySlots({ licenseType: c.licenseType, lv1: c.lv1, dmvNo: c.dmvNo });
      const res = await applySlots(db, c.licenseType, c.dmvNo, slots, now, today);
      events += res.events;
      writes += res.writes;
      ok++;
      await scanLogStmt(db, c.licenseType, c.dmvNo, true, now, slots.length, Date.now() - t0).run();
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      await scanLogStmt(db, c.licenseType, c.dmvNo, false, now, 0, Date.now() - t0, msg).run();
    }
  });

  await db.batch([
    setStateStmt(db, 'hot_cursor', String(hot.cursor)),
    setStateStmt(db, 'cold_cursor', String(cold.cursor)),
    setStateStmt(db, 'last_tick', String(now)),
  ]);

  await maybeCleanup(db, now, today);

  return { scanned: batch.length, ok, failed, events, writes, skipped: skip.size };
}

async function maybeCleanup(db: D1Database, now: number, today: string) {
  const last = Number((await getState(db, 'last_cleanup')) ?? 0) || 0;
  if (now - last < 24 * 3600 * 1000) return;
  await db.batch([
    db.prepare('DELETE FROM slot_event WHERE at < ?').bind(now - EVENT_RETENTION_MS),
    db.prepare('DELETE FROM slot WHERE exam_date < ?').bind(today),
    setStateStmt(db, 'last_cleanup', String(now)),
  ]);
}
