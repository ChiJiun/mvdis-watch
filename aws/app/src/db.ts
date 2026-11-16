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

/**
 * schema 名稱會拼進 SQL 的表名（`<schema>.slot_event`），只接受小寫識別字。
 * 未知 target 取到 undefined 時一定要丟例外：插值成 'undefined' 的 search_path 不會報錯，會靜默落到 public。
 */
export function schemaIdent(name: unknown): string {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) throw new Error(`不合法的 schema 名稱：${String(name)}`);
  return name;
}

/** 這個 target 的資料 schema；target 不在對應表裡就丟例外 */
export function schemaFor(schemas: DbSchemas, target: string): string {
  if (!Object.hasOwn(schemas, target)) throw new Error(`未知的 target：${target}`);
  return schemaIdent(schemas[target as ScanTarget]);
}

/** replay 任務會寫的三張表（契約 §7.3） */
export const REPLAY_TABLES = ['slot', 'slot_event', 'scan_log'] as const;

const replayReady = new WeakMap<Pool, Set<string>>();

/**
 * replay schema 的三張表是否都存在（`to_regclass`）。
 * `SET LOCAL search_path = replay, public` 在 replay 缺表時不會報錯，而是靜默寫進 public（契約 #3 第 3 輪 review R3-1），
 * 所以處理 replay 任務前一定要先確認。確認過就記住（表不會自己消失）；缺表時不記，migrate 之後下一則就會通過。
 * 回傳缺少的表（全部存在時為空陣列）。
 */
export async function missingReplayTables(pool: Pool, replaySchema: string): Promise<string[]> {
  const schema = schemaIdent(replaySchema);
  if (replayReady.get(pool)?.has(schema)) return [];
  const names = REPLAY_TABLES.map((t) => `${schema}.${t}`);
  const r = await pool.query<{ name: string; oid: string | null }>(
    'SELECT name, to_regclass(name)::text AS oid FROM unnest($1::text[]) AS name',
    [names],
  );
  const missing = r.rows.filter((x) => x.oid === null).map((x) => x.name);
  if (!missing.length) {
    if (!replayReady.has(pool)) replayReady.set(pool, new Set());
    replayReady.get(pool)!.add(schema);
  }
  return missing;
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
