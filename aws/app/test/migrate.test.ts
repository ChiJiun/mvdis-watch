import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { describeTarget, migrate } from '../scripts/migrate.ts';
import { TEST_DATABASE_URL } from './helpers/pg.ts';

test('describeTarget：不印出密碼', () => {
  assert.equal(describeTarget({ DATABASE_URL: 'postgres://u:secret@db.local:5433/mvdis' }), 'db.local:5433/mvdis');
  assert.equal(describeTarget({ DB_HOST: 'rds.example', DB_NAME: 'x' }), 'rds.example:5432/x');
});

test('migrate：套用 schema（含 replay schema），重複執行也安全', { skip: !TEST_DATABASE_URL && 'TEST_DATABASE_URL 未設定' }, async () => {
  const schema = `test_migrate_${process.pid}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  try {
    const u = new URL(TEST_DATABASE_URL!);
    u.searchParams.set('options', `-c search_path=${schema}`);
    await migrate({ DATABASE_URL: u.toString() });
    await migrate({ DATABASE_URL: u.toString() });
    const r = await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    );
    assert.deepEqual(
      r.rows.map((x) => x.table_name),
      ['scan_log', 'scan_task_log', 'slot', 'slot_event'],
    );
    // 契約 §7.3：replay schema 是寫死的名字（schema.pg.sql 後段），這裡只確認建得出來、不刪它，
    // 因為 TEST_DATABASE_URL 若指向本機 compose 的 DB，replay schema 裡可能有 e2e 的資料
    const rp = await admin.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'replay' ORDER BY table_name`,
    );
    assert.deepEqual(
      rp.rows.map((x) => x.table_name),
      ['scan_log', 'slot', 'slot_event'],
    );
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
