/**
 * Postgres 連線。本機用 DATABASE_URL；AWS 上用 DB_HOST/DB_PORT/DB_NAME，
 * 帳密從 Secrets Manager 的 DB_SECRET_ARN 取（JSON `{"username","password"}`）。
 */
import pg from 'pg';
import { intOr, required, type Env } from './config.ts';
import { getSecretJson } from './secrets.ts';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

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
