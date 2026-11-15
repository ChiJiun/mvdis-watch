/**
 * 需要真 Postgres 的測試用。設定 TEST_DATABASE_URL（例如 docker compose 起的
 * postgres://mvdis:mvdis@localhost:5432/mvdis）才會跑；每個測試檔建一個獨立 schema，
 * 套用 aws/db/schema.pg.sql，結束時整個丟掉，不影響既有資料。
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { SCHEMA_PATH } from '../../scripts/migrate.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function createTestPool(max = 6): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL 未設定');
  const schema = `test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await admin.query(await readFile(SCHEMA_PATH, 'utf8'));
  await admin.end();

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max, options: `-c search_path=${schema}` });
  return {
    pool,
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}
