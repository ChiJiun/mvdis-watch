/**
 * Postgres 連線。本機用 DATABASE_URL；AWS 上用 DB_HOST/DB_PORT/DB_NAME，
 * 帳密從 Secrets Manager 的 DB_SECRET_ARN 取（JSON `{"username","password"}`）。
 */
import pg from 'pg';
import { DB_SCHEMA_BY_TARGET, PG_TYPE_RULES, type ScanTarget } from '../../shared/contracts.ts';
import { intOr, required, type Env } from './config.ts';
import { getSecretJson } from './secrets.ts';

/**
 * 套用契約 §7.1 的型別轉換：date → 'yyyy-mm-dd'、bigint/numeric → Number、bool → 0/1。
 * node-postgres 的 type parser 是全域設定，建立任何連線前呼叫一次即可（重複呼叫無妨）。
 */
export function applyPgTypeRules(): void {
  for (const [oid, parse] of Object.entries(PG_TYPE_RULES)) pg.types.setTypeParser(Number(oid), parse);
}

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * 各 target 的 slot／slot_event／scan_log 所在 schema（契約 §7.3）。正式環境就是 DB_SCHEMA_BY_TARGET；
 * 測試傳每個測試檔自己的 schema。`live` 那個 schema 同時也放 scan_task_log（正式環境是 public）。
 */
export type DbSchemas = Record<ScanTarget, string>;
export const DEFAULT_SCHEMAS: DbSchemas = { ...DB_SCHEMA_BY_TARGET };

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** schema 名稱會直接拼進 SQL（SET LOCAL search_path 不能用參數），只接受小寫識別字 */
export function schemaIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`不合法的 schema 名稱：${name}`);
  return name;
}

export async function poolConfig(env: Env, max: number): Promise<pg.PoolConfig> {
  const base: pg.PoolConfig = {
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // 卡住的查詢不能比 SQS 可見性逾時（60 秒）還久，否則訊息會被別台重複處理
    statement_timeout: 20_000,
    application_name: env.DB_APPLICATION_NAME || 'mvdis-watch',
  };
  if (env.DATABASE_URL) return { ...base, connectionString: env.DATABASE_URL };

  const secret = await getSecretJson<{ username: string; password: string }>(env, required(env, 'DB_SECRET_ARN'));
  return {
    ...base,
    host: required(env, 'DB_HOST'),
    port: intOr(env.DB_PORT, 5432),
    database: env.DB_NAME || 'mvdis',
    user: secret.username,
    password: secret.password,
    // RDS PostgreSQL 16 預設 rds.force_ssl=1，一定要開 TLS。
    // 只在 VPC 內連線，先不驗證憑證鏈（不打包 RDS CA bundle）；見 PR 說明。
    ssl: { rejectUnauthorized: false },
  };
}

export async function createPool(env: Env, max: number): Promise<Pool> {
  applyPgTypeRules();
  const pool = new pg.Pool(await poolConfig(env, max));
  pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', error: e.message })));
  return pool;
}

export async function withTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
