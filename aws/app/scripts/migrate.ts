/**
 * `npm run migrate`：把 aws/db/schema.pg.sql 套用到 DATABASE_URL（本機）或 RDS（DB_HOST + DB_SECRET_ARN）。
 *
 * schema 全部是 CREATE … IF NOT EXISTS，重複執行是安全的。整份在單一交易內執行，
 * 中途失敗不會留下一半的表。
 *
 *   npm run migrate                 # 套用
 *   npm run migrate -- --dry-run    # 只印出要執行的 SQL 與連線目標，不連資料庫
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../src/config.ts';
import { createPool, withTransaction } from '../src/db.ts';

export const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'schema.pg.sql');

export function describeTarget(env: Env): string {
  if (env.DATABASE_URL) {
    try {
      const u = new URL(env.DATABASE_URL);
      return `${u.hostname}:${u.port || 5432}${u.pathname}`;
    } catch {
      return 'DATABASE_URL';
    }
  }
  return `${env.DB_HOST ?? '(未設定 DB_HOST)'}:${env.DB_PORT ?? 5432}/${env.DB_NAME ?? 'mvdis'}`;
}

export async function migrate(env: Env, sql?: string): Promise<void> {
  const schema = sql ?? (await readFile(SCHEMA_PATH, 'utf8'));
  const pool = await createPool(env, 1);
  try {
    await withTransaction(pool, (c) => c.query(schema));
  } finally {
    await pool.end();
  }
}

const norm = (p: string) => resolve(p).toLowerCase();
const isMain = !!process.argv[1] && norm(fileURLToPath(import.meta.url)) === norm(process.argv[1]);
if (isMain) {
  const env = process.env as Env;
  const dry = process.argv.includes('--dry-run');
  const target = describeTarget(env);
  if (dry) {
    console.log(`[dry-run] 目標：${target}`);
    console.log(await readFile(SCHEMA_PATH, 'utf8'));
  } else {
    console.log(`套用 ${SCHEMA_PATH} → ${target}`);
    migrate(env).then(
      () => console.log('完成'),
      (e) => {
        console.error(`失敗：${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      },
    );
  }
}
