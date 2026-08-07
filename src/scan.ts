/**
 * 分層分片排程。
 *
 * 三個限制同時綁著這支的形狀，改動前請先看懂：
 *
 *   1. Workers 免費方案單次呼叫最多 **50 個 subrequest** → 一次不能抓太多組合。
 *   2. Workers 免費方案單次 **CPU 10 ms** → 解析要便宜（見 mvdis.ts 的切片解析）。
 *   3. D1 免費方案單次呼叫最多 **50 個查詢**，batch 裡每個 statement 都算一個
 *      → 所以讀取全部合併成 3 個查詢，寫入用預算上限守住（見 WRITE_BUDGET）。
 *
 * 分層的理由：熱門照類（機車、普通小型車）才是會被搶的，冷門的職業／大車／
 * 聯結車幾乎不會滿。實測 360 組中有 153 組根本沒有任何場次，全部同頻率掃
 * 是對政府網站的浪費。
 *
 *   熱門層 108 組（3/5/A × 36 站）  每 10 分鐘輪完一次
 *   冷門層 252 組（其餘 7 種照類）   每 2 小時輪完一次
 *   連續 5 次抓到空結果的組合降頻成每 24 小時複查一次
 */
import { hotCombos, coldCombos, type Combo } from './catalogue.ts';
import { querySlots, mapLimit, type Slot } from './mvdis.ts';
import {
  diffCombo,
  diffCost,
  buildWriteStatements,
  scanLogStmts,
  loadExisting,
  getStates,
  setStatesStmt,
  type ComboDiff,
} from './db.ts';
import { notifyReleased } from './notify.ts';

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

/**
 * 一次 tick 最多送出幾個寫入 statement，用來守住 D1 免費方案的 50 查詢上限。
 *
 * 最壞情況的完整帳：
 *   讀取 3（降頻清單、排程狀態、既有場次）
 * + 讀取 2（通知訂閱與其追蹤清單，只在有釋位事件時才發生）
 * + 寫入 30（本預算）
 * + scan_log 2 + 排程狀態 1 + 通知回寫 5 + 每日清理 2
 * = 45 < 50
 *
 * 超出預算的組合這輪不套用、游標也不前進，下一輪會重來。只有第一次建表時
 * 會碰到，穩態下每輪通常只有個位數 statement。
 */
const WRITE_BUDGET = 30;

export function todayIso(now: Date = new Date()): string {
  const tw = new Date(now.getTime() + 8 * 3600 * 1000);
  return tw.toISOString().slice(0, 10);
}

const comboKey = (c: Combo) => `${c.licenseType}|${c.dmvNo}`;

/**
 * 從游標往後取 n 個未被降頻的組合。
 * 同時回傳「套用到第 i 個之後游標該在哪」，因為預算不足時只會套用前面幾個。
 */
function take(list: Combo[], cursor: number, n: number, skip: Set<string>) {
  const picked: Combo[] = [];
  const cursorAfter: number[] = [];
  let i = cursor;
  for (let steps = 0; steps < list.length && picked.length < n; steps++) {
    const c = list[i % list.length];
    i++;
    if (skip.has(comboKey(c))) continue;
    picked.push(c);
    cursorAfter.push(i % list.length);
  }
  return { picked, cursorAfter, cursor: i % list.length };
}

/**
 * 官網偶爾會中途關掉連線，也會短暫回 502（實測遇過，約一分鐘內自行恢復）。
 * 重試一次就好，而且要等一下再重試 —— 對方已經在噴錯了，立刻重打只是加重它的負擔。
 * 失敗會被記成 scan_log 的錯誤而不是「沒有場次」，所以不會誤觸降頻。
 */
async function fetchWithRetry(c: Combo): Promise<Slot[]> {
  const args = { licenseType: c.licenseType, lv1: c.lv1, dmvNo: c.dmvNo };
  try {
    return await querySlots(args);
  } catch {
    await new Promise((r) => setTimeout(r, 800));
    return await querySlots(args);
  }
}

export async function runScanTick(env: Env, now = Date.now()) {
  const db = env.DB;
  const today = todayIso(new Date(now));
  const hotN = Number(env.HOT_PER_TICK ?? 11);
  const coldN = Number(env.COLD_PER_TICK ?? 3);
  const concurrency = Number(env.FETCH_CONCURRENCY ?? 5);

  // === 讀取階段：固定 3 個查詢，不隨組合數成長 ===
  const prunedRes = await db
    .prepare('SELECT license_type, dmv_no FROM scan_log WHERE empty_streak >= ? AND last_ok > ?')
    .bind(PRUNE_AFTER_EMPTY, now - PRUNE_RECHECK_MS)
    .all<{ license_type: string; dmv_no: string }>();
  const skip = new Set((prunedRes.results ?? []).map((r) => `${r.license_type}|${r.dmv_no}`));

  const state = await getStates(db, ['hot_cursor', 'cold_cursor', 'last_cleanup']);
  const hotCursor = Number(state.get('hot_cursor') ?? 0) || 0;
  const coldCursor = Number(state.get('cold_cursor') ?? 0) || 0;
  const lastCleanup = Number(state.get('last_cleanup') ?? 0) || 0;

  const hot = take(HOT, hotCursor, hotN, skip);
  const cold = take(COLD, coldCursor, coldN, skip);
  const batch = [...hot.picked, ...cold.picked];

  // === 抓取階段：只有 fetch，不碰 D1 ===
  type Fetched = { combo: Combo; slots: Slot[] | null; error?: string; durationMs: number };
  const fetched: Fetched[] = await mapLimit(batch, concurrency, async (c) => {
    const t0 = Date.now();
    try {
      return { combo: c, slots: await fetchWithRetry(c), durationMs: Date.now() - t0 };
    } catch (e) {
      return {
        combo: c,
        slots: null,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - t0,
      };
    }
  });

  const okFetches = fetched.filter((f) => f.slots !== null);
  const existing = await loadExisting(db, okFetches.map((f) => f.combo));

  // === 差異階段：純計算，並用預算守住 statement 數 ===
  const diffs: ComboDiff[] = [];
  const applied: Fetched[] = [];
  let cost = 0;
  let budgetHit = false;

  for (const f of fetched) {
    if (f.slots === null) {
      applied.push(f); // 失敗的也要記 scan_log，游標照樣前進，否則會卡死在壞掉的組合
      continue;
    }
    const d = diffCombo(
      f.combo.licenseType,
      f.combo.dmvNo,
      f.slots,
      existing.get(comboKey(f.combo)) ?? [],
      now,
      today,
    );
    const c = diffCost(d);
    if (cost + c > WRITE_BUDGET && applied.length > 0) {
      budgetHit = true;
      break; // 這輪先到這裡，游標不前進，下一輪重來
    }
    cost += c;
    diffs.push(d);
    applied.push(f);
  }

  // === 寫入階段：全部塞進單一 batch ===
  const appliedHot = applied.filter((f) => HOT.some((h) => comboKey(h) === comboKey(f.combo))).length;
  const appliedCold = applied.length - appliedHot;

  const nextHot = appliedHot > 0 ? hot.cursorAfter[appliedHot - 1] : hotCursor;
  const nextCold = appliedCold > 0 ? cold.cursorAfter[appliedCold - 1] : coldCursor;

  const stmts = [
    ...buildWriteStatements(db, diffs, now),
    ...scanLogStmts(
      db,
      applied.map((f) => ({
        licenseType: f.combo.licenseType,
        dmvNo: f.combo.dmvNo,
        ok: f.slots !== null,
        rowsSeen: f.slots?.length ?? 0,
        durationMs: f.durationMs,
        error: f.error,
      })),
      now,
    ),
  ];

  const stateEntries: Array<[string, string]> = [
    ['hot_cursor', String(nextHot)],
    ['cold_cursor', String(nextCold)],
    ['last_tick', String(now)],
  ];

  // 只推「額滿 → 有位」，那是退考釋出的那一刻。詳見 notify.ts 開頭的說明。
  const released = diffs
    .flatMap((d) => d.events)
    .filter((e) => e.kind === 'released')
    .map((e) => ({
      licenseType: e.licenseType,
      dmvNo: e.dmvNo,
      examDate: e.examDate,
      secKey: e.secKey,
      newQuota: e.newQuota,
    }));
  const notified = await notifyReleased(db, released, now);
  stmts.push(...notified.stmts);

  const doCleanup = now - lastCleanup >= 24 * 3600 * 1000;
  if (doCleanup) stateEntries.push(['last_cleanup', String(now)]);
  stmts.push(setStatesStmt(db, stateEntries));

  if (doCleanup) {
    stmts.push(db.prepare('DELETE FROM slot_event WHERE at < ?').bind(now - EVENT_RETENTION_MS));
    stmts.push(db.prepare('DELETE FROM slot WHERE exam_date < ?').bind(today));
  }

  await db.batch(stmts);

  return {
    scanned: batch.length,
    applied: applied.length,
    ok: applied.filter((f) => f.slots !== null).length,
    failed: fetched.filter((f) => f.slots === null).length,
    events: diffs.reduce((a, d) => a + d.events.length, 0),
    writes: diffs.reduce((a, d) => a + d.upserts.length + d.deletes.length, 0),
    released: released.length,
    notified: notified.sent,
    notifyFailed: notified.failed,
    // 這輪一共用掉幾個 D1 查詢，免費方案上限 50。
    // 3 個固定讀取 +（有釋位時）2 個訂閱讀取 + batch 裡的每個 statement。
    d1Queries: 3 + (released.length ? 2 : 0) + stmts.length,
    budgetHit,
    skipped: skip.size,
  };
}
