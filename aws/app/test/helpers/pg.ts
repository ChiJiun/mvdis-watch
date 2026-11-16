/**
 * 需要真 Postgres 的測試用。設定 TEST_DATABASE_URL（例如 docker compose 起的
 * postgres://mvdis:mvdis@localhost:5432/mvdis）才會跑；每個測試檔建兩個獨立 schema：
 *   - `<name>`：取代 public（slot、slot_event、scan_log、scan_task_log）
 *   - `<name>_replay`：取代 replay（契約 §7.3，replay 任務的 slot、slot_event、scan_log）
 * 套用 aws/db/schema.pg.sql（把 `replay.` 換成自己的 schema），結束時整個丟掉，不影響既有資料。
 */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { SCHEMA_PATH } from '../../scripts/migrate.ts';
import { applyPgTypeRules, type DbSchemas } from '../../src/db.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** schema.pg.sql 裡寫死的 replay schema 換成測試用的名字 */
export function rewriteReplaySchema(sql: string, replaySchema: string): string {
  return sql
    .replace(/CREATE SCHEMA IF NOT EXISTS replay;/g, `CREATE SCHEMA IF NOT EXISTS ${replaySchema};`)
    .replace(/\breplay\.(?=[a-z_])/g, `${replaySchema}.`);
}

export async function createTestPool(
  max = 6,
): Promise<{ pool: pg.Pool; schemas: DbSchemas; drop: () => Promise<void> }> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL 未設定');
  applyPgTypeRules(); // 和正式環境一樣套用契約 §7.1 的型別規則
  const live = `test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const replay = `${live}_replay`;
  const sql = rewriteReplaySchema(await readFile(SCHEMA_PATH, 'utf8'), replay);
  if (/\breplay\.[a-z_]/.test(sql.replaceAll(`${replay}.`, ''))) throw new Error('schema 的 replay 沒有替換乾淨');

  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${live}`);
  await admin.query(`SET search_path TO ${live}`);
  await admin.query(sql);
  await admin.end();

  // 預設 search_path 只有 live 那個 schema，對應正式環境的 public
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max, options: `-c search_path=${live}` });
  return {
    pool,
    schemas: { live, replay },
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS ${replay} CASCADE`);
      await c.query(`DROP SCHEMA IF EXISTS ${live} CASCADE`);
      await c.end();
    },
  };
}
