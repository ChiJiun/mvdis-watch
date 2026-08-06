/**
 * D1 存取層。
 *
 * 寫入策略是整個設計的關鍵：**只有餘額真的變動時才寫 slot 列**。
 * 全量寫入會是每天數十萬列，直接撞破 D1 免費方案的 10 萬列/日上限；
 * 只寫差異之後每天只剩幾千列，而且差異本身就是我們要的「釋位事件」。
 * 所以不要為了「記錄最後看到時間」而每輪更新每一列。
 */
import type { Slot } from './mvdis.ts';
import { FULL } from './mvdis.ts';

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

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM scan_state WHERE key = ?').bind(key).first<{ value: string }>();
  return r ? r.value : null;
}

export function setStateStmt(db: D1Database, key: string, value: string) {
  return db
    .prepare('INSERT INTO scan_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value);
}

function classify(oldQuota: number, newQuota: number): EventKind | null {
  if (oldQuota === newQuota) return null;
  if (oldQuota === FULL && newQuota > 0) return 'released';
  if (newQuota === FULL && oldQuota > 0) return 'filled';
  if (newQuota > oldQuota) return 'increased';
  return 'decreased';
}

/**
 * 把一次查詢的結果套進資料庫，回傳這次產生的事件。
 * 呼叫端要保證 slots 是「該組合的完整結果」，否則沒出現的場次會被誤判成消失。
 */
export async function applySlots(
  db: D1Database,
  licenseType: string,
  dmvNo: string,
  slots: Slot[],
  now: number,
  today: string,
): Promise<{ events: number; writes: number }> {
  const existing = await db
    .prepare('SELECT * FROM slot WHERE license_type = ? AND dmv_no = ?')
    .bind(licenseType, dmvNo)
    .all<SlotRow>();

  const prev = new Map<string, SlotRow>();
  for (const r of existing.results ?? []) prev.set(`${r.exam_date}|${r.sec_key}`, r);

  const stmts: D1PreparedStatement[] = [];
  let events = 0;

  const upsert = db.prepare(
    `INSERT INTO slot (license_type, dmv_no, exam_date, sec_key, quota, signup_available,
                       sec_desc, session, grp, weekday, is_weekend, first_seen, updated_at, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(license_type, dmv_no, exam_date, sec_key) DO UPDATE SET
       quota = excluded.quota,
       signup_available = excluded.signup_available,
       sec_desc = excluded.sec_desc,
       updated_at = excluded.updated_at,
       seen_at = excluded.seen_at`,
  );
  const addEvent = db.prepare(
    `INSERT INTO slot_event (license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );

  const seen = new Set<string>();
  for (const s of slots) {
    const key = `${s.examDate}|${s.secKey}`;
    seen.add(key);
    const old = prev.get(key);

    if (old && old.quota === s.quota && old.signup_available === (s.signupAvailable ? 1 : 0)) {
      continue; // 沒變動就不寫，這是控制寫入量的核心
    }

    stmts.push(
      upsert.bind(
        licenseType,
        dmvNo,
        s.examDate,
        s.secKey,
        s.quota,
        s.signupAvailable ? 1 : 0,
        s.desc,
        s.session,
        s.group,
        s.weekday,
        s.isWeekend ? 1 : 0,
        old ? old.first_seen : now,
        now,
        now,
      ),
    );

    const kind: EventKind | null = old ? classify(old.quota, s.quota) : 'new';
    if (kind) {
      events++;
      stmts.push(
        addEvent.bind(licenseType, dmvNo, s.examDate, s.secKey, kind, old ? old.quota : null, s.quota, now),
      );
    }
  }

  // 場次從官網消失（通常是考試日過了，或監理站撤掉場次）
  const delStmt = db.prepare('DELETE FROM slot WHERE license_type=? AND dmv_no=? AND exam_date=? AND sec_key=?');
  for (const [key, row] of prev) {
    if (seen.has(key)) continue;
    if (row.exam_date < today) {
      stmts.push(delStmt.bind(licenseType, dmvNo, row.exam_date, row.sec_key)); // 過期，靜靜刪掉
    } else {
      events++;
      stmts.push(delStmt.bind(licenseType, dmvNo, row.exam_date, row.sec_key));
      stmts.push(addEvent.bind(licenseType, dmvNo, row.exam_date, row.sec_key, 'gone', row.quota, null, now));
    }
  }

  if (stmts.length) await db.batch(stmts);
  return { events, writes: stmts.length };
}

export function scanLogStmt(
  db: D1Database,
  licenseType: string,
  dmvNo: string,
  ok: boolean,
  now: number,
  rowsSeen: number,
  durationMs: number,
  error?: string,
) {
  if (ok) {
    return db
      .prepare(
        `INSERT INTO scan_log (license_type, dmv_no, last_ok, rows_seen, empty_streak, duration_ms)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(license_type, dmv_no) DO UPDATE SET
           last_ok = excluded.last_ok,
           rows_seen = excluded.rows_seen,
           empty_streak = CASE WHEN excluded.rows_seen = 0 THEN scan_log.empty_streak + 1 ELSE 0 END,
           duration_ms = excluded.duration_ms`,
      )
      .bind(licenseType, dmvNo, now, rowsSeen, rowsSeen === 0 ? 1 : 0, durationMs);
  }
  return db
    .prepare(
      `INSERT INTO scan_log (license_type, dmv_no, last_error, last_error_at, duration_ms)
       VALUES (?,?,?,?,?)
       ON CONFLICT(license_type, dmv_no) DO UPDATE SET
         last_error = excluded.last_error,
         last_error_at = excluded.last_error_at,
         duration_ms = excluded.duration_ms`,
    )
    .bind(licenseType, dmvNo, error ?? 'unknown', now, durationMs);
}

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
