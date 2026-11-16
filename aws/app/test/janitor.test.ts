import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { cleanup, RETENTION_MS } from '../src/janitor/index.ts';
import type { DbSchemas } from '../src/db.ts';
import { taipeiIsoDate } from '../../shared/contracts.ts';
import { createTestPool, TEST_DATABASE_URL } from './helpers/pg.ts';

describe('janitor（Postgres）', { skip: !TEST_DATABASE_URL && 'TEST_DATABASE_URL 未設定' }, () => {
  let pool: pg.Pool;
  let schemas: DbSchemas;
  let drop: () => Promise<void>;
  before(async () => {
    ({ pool, schemas, drop } = await createTestPool(2));
  });
  after(async () => {
    await drop?.();
  });

  test('public 與 replay 兩個 schema：刪 30 天前的事件、考試日已過（台灣日期）的場次；30 天前的任務紀錄；其餘保留', async () => {
    const now = Date.UTC(2026, 10, 16, 20, 0, 0); // 台灣時間 11/17 04:00（UTC 還是 11/16）
    const today = taipeiIsoDate(now);
    assert.equal(today, '2026-11-17');
    const oldTs = now - RETENTION_MS - 1;
    const newTs = now - RETENTION_MS + 60_000;

    for (const s of [schemas.live, schemas.replay]) {
      for (const [date, key] of [
        ['2026-11-16', 'past'],
        ['2026-11-17', 'today'],
        ['2026-12-01', 'future'],
      ]) {
        await pool.query(
          `INSERT INTO ${s}.slot (license_type, dmv_no, exam_date, sec_key, quota, is_weekend, first_seen, updated_at, seen_at)
           VALUES ('3', '63', $1, $2, 1, TRUE, 0, 0, 0)`,
          [date, key],
        );
      }
      for (const at of [oldTs, newTs]) {
        await pool.query(
          `INSERT INTO ${s}.slot_event (license_type, dmv_no, exam_date, sec_key, kind, new_quota, at)
           VALUES ('3', '63', '2026-12-01', 'x', 'new', 1, $1)`,
          [at],
        );
      }
    }
    for (const [id, at] of [
      ['00000000-0000-4000-8000-000000000001', oldTs],
      ['00000000-0000-4000-8000-000000000002', newTs],
    ] as const) {
      await pool.query(
        `INSERT INTO scan_task_log (task_id, license_type, dmv_no, tier, target, enqueued_at)
         VALUES ($1, '3', '63', 'hot', 'live', $2)`,
        [id, at],
      );
    }

    const r = await cleanup(pool, now, schemas);
    assert.deepEqual(r, { slotEvents: 2, slots: 2, taskLogs: 1, today });
    for (const s of [schemas.live, schemas.replay]) {
      const slots = await pool.query(`SELECT sec_key FROM ${s}.slot ORDER BY exam_date`);
      assert.deepEqual(slots.rows.map((x) => x.sec_key), ['today', 'future'], s);
      assert.deepEqual((await pool.query(`SELECT at FROM ${s}.slot_event`)).rows, [{ at: newTs }], s);
    }

    const again = await cleanup(pool, now, schemas);
    assert.deepEqual([again.slotEvents, again.slots, again.taskLogs], [0, 0, 0], '重複執行安全');
  });
});
