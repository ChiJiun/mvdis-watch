/**
 * D1 存取層。
 *
 * 這一層被兩個 D1 免費方案的硬限制綁死，改動時務必先看懂：
 *
 *   1. **每次 Worker 呼叫最多 50 個查詢**（付費 1000）。batch 裡的每個 statement
 *      都各自算一個，所以「每個組合各跑一次 SELECT／各寫一次 scan_log」這種
 *      直覺寫法，14 個組合就 35 次起跳、變動一多就爆掉。
 *      因此：讀取一律合併成單一查詢，寫入一律合併成多列 statement。
 *   2. **每個查詢最多 100 個綁定參數**。所以多列寫入必須分塊：
 *      slot 有 14 欄 → 每 statement 最多 7 列；slot_event 有 8 欄 → 最多 12 列。
 *
 * 另外，寫入策略本身也是刻意的：**只有餘額真的變動時才寫 slot 列**。
 * 全量寫入約每天 40 萬列，會撞破 10 萬列/日的上限；只寫差異之後每天只剩幾千列，
 * 而差異本身就是我們要的「釋位事件」。不要為了記錄「最後看到時間」而每輪更新每一列。
 */
import type { Slot } from './mvdis.ts';
import { FULL } from './mvdis.ts';
import type { Combo } from './catalogue.ts';

export type EventKind = 'released' | 'increased' | 'decreased' | 'filled' | 'new' | 'gone';

export type SlotRow = {
  license_type: string;
  dmv_no: string;
  exam_date: string;
  sec_key: string;
  quota: number;
  signup_available: number;
  sec_desc: string | null;
  session: string | null;
  grp: number | null;
  weekday: string | null;
  is_weekend: number;
  first_seen: number;
  updated_at: number;
};

/** D1 每個查詢最多 100 個綁定參數 */
const MAX_PARAMS = 100;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ---------- 排程狀態 ---------- */

/** 一次讀完所有狀態鍵，不要一個鍵一個查詢 */
export async function getStates(db: D1Database, keys: string[]): Promise<Map<string, string>> {
  const r = await db
    .prepare(`SELECT key, value FROM scan_state WHERE key IN (${keys.map(() => '?').join(',')})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  return new Map((r.results ?? []).map((x) => [x.key, x.value]));
}

/** 多個狀態鍵合併成單一 statement */
export function setStatesStmt(db: D1Database, entries: Array<[string, string]>) {
  const values = entries.map(() => '(?,?)').join(',');
  return db
    .prepare(`INSERT INTO scan_state (key, value) VALUES ${values}
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(...entries.flat());
}

/* ---------- 讀取現況 ---------- */

/** 一次讀完這批組合的所有既有場次。用 OR 條件而不是字串拼接，才走得到主鍵索引。 */
export async function loadExisting(db: D1Database, combos: Combo[]): Promise<Map<string, SlotRow[]>> {
  const byCombo = new Map<string, SlotRow[]>();
  for (const c of combos) byCombo.set(`${c.licenseType}|${c.dmvNo}`, []);
  if (!combos.length) return byCombo;

  // 每個組合 2 個參數，100 參數上限 → 每次最多 50 個組合，實務上一次只有十幾個
  for (const part of chunk(combos, Math.floor(MAX_PARAMS / 2))) {
    const cond = part.map(() => '(license_type = ? AND dmv_no = ?)').join(' OR ');
    const binds = part.flatMap((c) => [c.licenseType, c.dmvNo]);
    const r = await db.prepare(`SELECT * FROM slot WHERE ${cond}`).bind(...binds).all<SlotRow>();
    for (const row of r.results ?? []) byCombo.get(`${row.license_type}|${row.dmv_no}`)?.push(row);
  }
  return byCombo;
}

/* ---------- 差異計算 ---------- */

function classify(oldQuota: number, newQuota: number): EventKind | null {
  if (oldQuota === newQuota) return null;
  if (oldQuota === FULL && newQuota > 0) return 'released';
  if (newQuota === FULL && oldQuota > 0) return 'filled';
  if (newQuota > oldQuota) return 'increased';
  return 'decreased';
}

type PendingEvent = {
  licenseType: string;
  dmvNo: string;
  examDate: string;
  secKey: string;
  kind: EventKind;
  oldQuota: number | null;
  newQuota: number | null;
};

type PendingDelete = { licenseType: string; dmvNo: string; examDate: string; secKey: string };

export type ComboDiff = {
  upserts: Slot[];
  /** 沿用原本的 first_seen，新場次才給 now */
  firstSeen: Map<string, number>;
  events: PendingEvent[];
  deletes: PendingDelete[];
};

/**
 * 純計算，不碰 IO。呼叫端要保證 slots 是該組合的完整結果，
 * 否則沒出現的場次會被誤判成消失。
 */
export function diffCombo(
  licenseType: string,
  dmvNo: string,
  slots: Slot[],
  existing: SlotRow[],
  now: number,
  today: string,
): ComboDiff {
  const prev = new Map<string, SlotRow>();
  for (const r of existing) prev.set(`${r.exam_date}|${r.sec_key}`, r);

  const diff: ComboDiff = { upserts: [], firstSeen: new Map(), events: [], deletes: [] };
  const seen = new Set<string>();

  for (const s of slots) {
    const key = `${s.examDate}|${s.secKey}`;
    seen.add(key);
    const old = prev.get(key);

    if (old && old.quota === s.quota && old.signup_available === (s.signupAvailable ? 1 : 0)) {
      continue; // 沒變動就不寫，這是控制寫入量的核心
    }

    diff.upserts.push(s);
    diff.firstSeen.set(key, old ? old.first_seen : now);

    const kind = old ? classify(old.quota, s.quota) : 'new';
    if (kind) {
      diff.events.push({
        licenseType,
        dmvNo,
        examDate: s.examDate,
        secKey: s.secKey,
        kind,
        oldQuota: old ? old.quota : null,
        newQuota: s.quota,
      });
    }
  }

  for (const [key, row] of prev) {
    if (seen.has(key)) continue;
    diff.deletes.push({ licenseType, dmvNo, examDate: row.exam_date, secKey: row.sec_key });
    // 考試日過了就是自然汰除，不值得記成事件
    if (row.exam_date >= today) {
      diff.events.push({
        licenseType,
        dmvNo,
        examDate: row.exam_date,
        secKey: row.sec_key,
        kind: 'gone',
        oldQuota: row.quota,
        newQuota: null,
      });
    }
  }
  return diff;
}

/** 這份差異需要幾個 statement —— 排程用它來守住 50 查詢的預算 */
export function diffCost(d: ComboDiff): number {
  return (
    Math.ceil(d.upserts.length / 7) + Math.ceil(d.events.length / 12) + Math.ceil(d.deletes.length / 25)
  );
}

/* ---------- 產生寫入 statement ---------- */

const SLOT_COLS = 14;
const EVENT_COLS = 8;

export function buildWriteStatements(db: D1Database, diffs: ComboDiff[], now: number): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];

  const upserts = diffs.flatMap((d) => d.upserts.map((s) => ({ s, firstSeen: d.firstSeen.get(`${s.examDate}|${s.secKey}`) ?? now })));
  for (const part of chunk(upserts, Math.floor(MAX_PARAMS / SLOT_COLS))) {
    const values = part.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const binds = part.flatMap(({ s, firstSeen }) => [
      s.licenseType, s.dmvNo, s.examDate, s.secKey, s.quota, s.signupAvailable ? 1 : 0,
      s.desc, s.session, s.group, s.weekday, s.isWeekend ? 1 : 0, firstSeen, now, now,
    ]);
    stmts.push(
      db.prepare(
        `INSERT INTO slot (license_type, dmv_no, exam_date, sec_key, quota, signup_available,
                           sec_desc, session, grp, weekday, is_weekend, first_seen, updated_at, seen_at)
         VALUES ${values}
         ON CONFLICT(license_type, dmv_no, exam_date, sec_key) DO UPDATE SET
           quota = excluded.quota,
           signup_available = excluded.signup_available,
           sec_desc = excluded.sec_desc,
           updated_at = excluded.updated_at,
           seen_at = excluded.seen_at`,
      ).bind(...binds),
    );
  }

  const events = diffs.flatMap((d) => d.events);
  for (const part of chunk(events, Math.floor(MAX_PARAMS / EVENT_COLS))) {
    const values = part.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    const binds = part.flatMap((e) => [
      e.licenseType, e.dmvNo, e.examDate, e.secKey, e.kind, e.oldQuota, e.newQuota, now,
    ]);
    stmts.push(
      db.prepare(
        `INSERT INTO slot_event (license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at)
         VALUES ${values}`,
      ).bind(...binds),
    );
  }

  const deletes = diffs.flatMap((d) => d.deletes);
  for (const part of chunk(deletes, 25)) {
    const cond = part.map(() => '(license_type=? AND dmv_no=? AND exam_date=? AND sec_key=?)').join(' OR ');
    const binds = part.flatMap((d) => [d.licenseType, d.dmvNo, d.examDate, d.secKey]);
    stmts.push(db.prepare(`DELETE FROM slot WHERE ${cond}`).bind(...binds));
  }

  return stmts;
}

/** 所有組合的掃描健康度合併成單一 statement（6 欄 → 一次最多 16 個組合） */
export function scanLogStmts(
  db: D1Database,
  rows: Array<{ licenseType: string; dmvNo: string; ok: boolean; rowsSeen: number; durationMs: number; error?: string }>,
  now: number,
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];

  const oks = rows.filter((r) => r.ok);
  for (const part of chunk(oks, 16)) {
    const values = part.map(() => '(?,?,?,?,?,?)').join(',');
    const binds = part.flatMap((r) => [r.licenseType, r.dmvNo, now, r.rowsSeen, r.rowsSeen === 0 ? 1 : 0, r.durationMs]);
    stmts.push(
      db.prepare(
        `INSERT INTO scan_log (license_type, dmv_no, last_ok, rows_seen, empty_streak, duration_ms)
         VALUES ${values}
         ON CONFLICT(license_type, dmv_no) DO UPDATE SET
           last_ok = excluded.last_ok,
           rows_seen = excluded.rows_seen,
           empty_streak = CASE WHEN excluded.rows_seen = 0 THEN scan_log.empty_streak + 1 ELSE 0 END,
           duration_ms = excluded.duration_ms`,
      ).bind(...binds),
    );
  }

  const bad = rows.filter((r) => !r.ok);
  for (const part of chunk(bad, 20)) {
    const values = part.map(() => '(?,?,?,?,?)').join(',');
    const binds = part.flatMap((r) => [r.licenseType, r.dmvNo, r.error ?? 'unknown', now, r.durationMs]);
    stmts.push(
      db.prepare(
        `INSERT INTO scan_log (license_type, dmv_no, last_error, last_error_at, duration_ms)
         VALUES ${values}
         ON CONFLICT(license_type, dmv_no) DO UPDATE SET
           last_error = excluded.last_error,
           last_error_at = excluded.last_error_at,
           duration_ms = excluded.duration_ms`,
      ).bind(...binds),
    );
  }
  return stmts;
}

/* ---------- 儀表板查詢 ---------- */

export type AvailableFilter = {
  county?: string;
  lv1?: string;
  dmvNo?: string;
  licenseType?: string;
  from?: string;
  to?: string;
  weekendOnly?: boolean;
  minQuota?: number;
  limit?: number;
};

export async function queryAvailable(db: D1Database, f: AvailableFilter, dmvNosForCounty?: string[]) {
  const where: string[] = ['quota >= ?'];
  const binds: unknown[] = [Math.max(1, f.minQuota ?? 1)];

  if (f.dmvNo) {
    where.push('dmv_no = ?');
    binds.push(f.dmvNo);
  } else if (dmvNosForCounty && dmvNosForCounty.length) {
    where.push(`dmv_no IN (${dmvNosForCounty.map(() => '?').join(',')})`);
    binds.push(...dmvNosForCounty);
  }
  if (f.licenseType) {
    where.push('license_type = ?');
    binds.push(f.licenseType);
  }
  if (f.from) {
    where.push('exam_date >= ?');
    binds.push(f.from);
  }
  if (f.to) {
    where.push('exam_date <= ?');
    binds.push(f.to);
  }
  if (f.weekendOnly) where.push('is_weekend = 1');

  const limit = Math.min(Math.max(f.limit ?? 300, 1), 1000);
  const sql = `SELECT * FROM slot WHERE ${where.join(' AND ')} ORDER BY exam_date ASC, quota DESC LIMIT ${limit}`;
  const r = await db.prepare(sql).bind(...binds).all<SlotRow>();
  return r.results ?? [];
}

export async function queryEvents(db: D1Database, kind: string | null, limit: number) {
  const lim = Math.min(Math.max(limit, 1), 500);
  const sql = kind
    ? `SELECT * FROM slot_event WHERE kind = ? ORDER BY at DESC LIMIT ${lim}`
    : `SELECT * FROM slot_event ORDER BY at DESC LIMIT ${lim}`;
  const stmt = kind ? db.prepare(sql).bind(kind) : db.prepare(sql);
  const r = await stmt.all();
  return r.results ?? [];
}

export async function queryCombo(db: D1Database, licenseType: string, dmvNo: string) {
  const r = await db
    .prepare('SELECT * FROM slot WHERE license_type = ? AND dmv_no = ? ORDER BY exam_date ASC, sec_key ASC')
    .bind(licenseType, dmvNo)
    .all<SlotRow>();
  return r.results ?? [];
}

export async function scanHealth(db: D1Database) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS combos,
              MAX(last_ok) AS newest,
              MIN(COALESCE(last_ok, 0)) AS oldest,
              SUM(CASE WHEN empty_streak >= 5 THEN 1 ELSE 0 END) AS pruned,
              SUM(CASE WHEN last_error_at > COALESCE(last_ok, 0) THEN 1 ELSE 0 END) AS failing
       FROM scan_log`,
    )
    .first();
  return r ?? {};
}
