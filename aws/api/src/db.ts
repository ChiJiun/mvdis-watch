/**
 * PostgreSQL 連線池。
 *
 * 設定來源（見 aws/CONTRACTS.md 第 3 節）：
 *   - `DATABASE_URL` 有值就直接用（本機開發、測試）。
 *   - 否則用 `DB_HOST`／`DB_PORT`／`DB_NAME`，帳密從 Secrets Manager 的 `DB_SECRET_ARN` 取
 *     （secret 內容為 JSON `{"username":"…","password":"…"}`）。
 *
 * api 自己的選用變數（不在契約裡，infra 不設也能跑）：
 *   - `DB_POOL_MAX`：每台 EC2 給 API 查詢用的連線池上限，預設 10。ASG 擴到 N 台時 RDS 會有
 *     N × (DB_POOL_MAX + 1) 條連線（+1 是健康檢查專用連線），要和 RDS 機型的 max_connections 一起算。
 *   - `DB_SSL`：`disable`／`no-verify`／`verify`。走 DB_HOST 路徑時預設 `no-verify`
 *     （RDS PostgreSQL 15 起預設 rds.force_ssl=1，不開 SSL 連不上）；走 DATABASE_URL 時預設 `disable`，
 *     要加密就在 URL 帶 sslmode 或設這個變數。
 *   - `DB_STATEMENT_TIMEOUT_MS`：單一查詢逾時，預設 10000。
 *   - `DB_CONNECT_TIMEOUT_MS`：從連線池取得連線的等待上限，預設 5000。包含排隊等空出來的連線，
 *     以及需要開新連線時的 TCP＋TLS＋認證時間。**超過這個時間，該請求就回 500**——
 *     E1 壓測時的錯誤率與 p95 要用這個值來解讀。
 *   - 用戶端查詢逾時固定為 `DB_STATEMENT_TIMEOUT_MS + 2000`（見 poolConfigFromEnv）。
 */
import pg from 'pg';
import { PG_TYPE_RULES } from '../../shared/contracts.ts';

/**
 * 讓 Postgres 的回傳值長得和原型（D1／SQLite）一模一樣，規則統一定義在 aws/shared/contracts.ts
 * （CONTRACTS.md §7.1）：DATE → `YYYY-MM-DD` 字串、INT8／NUMERIC → number、BOOLEAN → 0／1。
 * 用連線池層級的 `types`，不改 pg 的全域設定。
 */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    return PG_TYPE_RULES[oid] ?? pg.types.getTypeParser(oid, format as 'text');
  },
};

/**
 * 每條連線的 session 設定：
 *   - `search_path=public`：api 只讀 public（CONTRACTS.md §7.3），不會因為 DB 端的預設值被改而讀到 replay schema。
 *   - `DateStyle=ISO`：DATE 的文字格式固定是 `YYYY-MM-DD`，type parser 才能原樣回傳。
 */
const SESSION_OPTIONS = '-c search_path=public -c DateStyle=ISO';

type Env = Record<string, string | undefined>;

function sslOption(mode: string | undefined): pg.PoolConfig['ssl'] {
  switch (mode) {
    case undefined:
    case '':
    case 'disable':
      return undefined;
    case 'no-verify':
      return { rejectUnauthorized: false };
    case 'verify':
      return { rejectUnauthorized: true };
    default:
      throw new Error(`DB_SSL 只能是 disable／no-verify／verify，收到 ${mode}`);
  }
}

function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} 必須是正整數，收到 ${raw}`);
  return n;
}

async function readDbSecret(arn: string): Promise<{ username: string; password: string }> {
  // 延遲載入：本機用 DATABASE_URL 時完全不碰 AWS SDK
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!out.SecretString) throw new Error('DB secret 沒有 SecretString');
  const s = JSON.parse(out.SecretString) as { username?: string; password?: string };
  if (!s.username || !s.password) throw new Error('DB secret 缺少 username 或 password');
  return { username: s.username, password: s.password };
}

/** 依環境變數組出 API 連線池的設定。抽出來是為了讓測試能直接檢查，不必真的連線。 */
export async function poolConfigFromEnv(env: Env = process.env): Promise<pg.PoolConfig> {
  const statementTimeout = intEnv(env, 'DB_STATEMENT_TIMEOUT_MS', 10000);
  const common: pg.PoolConfig = {
    max: intEnv(env, 'DB_POOL_MAX', 10),
    connectionTimeoutMillis: intEnv(env, 'DB_CONNECT_TIMEOUT_MS', 5000),
    idleTimeoutMillis: 30000,
    statement_timeout: statementTimeout,
    // statement_timeout 是伺服器端的設定，DB 無聲斷線（例如 RDS 切換時收不到 RST）時不會觸發；
    // 用戶端的 query_timeout 才會。逾時後 pg-pool 會丟掉並 destroy 那條連線，不會一直佔著。
    // 比 statement_timeout 多 2 秒，正常的慢查詢仍由伺服器端先取消。
    query_timeout: statementTimeout + 2000,
    keepAlive: true,
    application_name: 'mvdis-api',
    options: SESSION_OPTIONS,
    types,
  };

  if (env.DATABASE_URL) {
    return { ...common, connectionString: env.DATABASE_URL, ssl: sslOption(env.DB_SSL) };
  }

  const missing = ['DB_HOST', 'DB_NAME', 'DB_SECRET_ARN'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`沒有 DATABASE_URL 時必須設定 ${missing.join('、')}`);
  const { username, password } = await readDbSecret(env.DB_SECRET_ARN!);
  return {
    ...common,
    host: env.DB_HOST,
    port: intEnv(env, 'DB_PORT', 5432),
    database: env.DB_NAME,
    user: username,
    password,
    ssl: sslOption(env.DB_SSL ?? 'no-verify'),
  };
}

/**
 * 健康檢查專用連線池的設定：只有 1 條常駐連線、等不到就快速失敗。
 * 和 API 共用連線池的話，壓測時 /healthz 會排在幾百個 API 查詢後面，等超過 ALB 的 5 秒逾時，
 * DB 明明連得到卻被判定不健康，ASG 就會在 E1 中途把 instance 換掉。
 *
 * 只有 1 條連線，所以 `query_timeout` 一定要有：那條連線無聲斷線時，卡住的 `SELECT 1` 會
 * 一直佔著唯一的連線，DB 恢復後 healthz 仍然逾時到 TCP 放棄為止（Linux 預設約 15 分鐘）。
 * 2.5 秒逾時後連線被丟掉，下一次檢查重新連線；整個檢查最壞約 2.5 秒，低於 ALB 的 5 秒逾時。
 */
export function healthPoolConfig(apiConfig: pg.PoolConfig): pg.PoolConfig {
  return {
    ...apiConfig,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 2500,
    idleTimeoutMillis: 0, // 不回收，省掉每次健康檢查的連線建立（含 TLS）成本
    application_name: 'mvdis-api-health',
  };
}

export type Queryable = Pick<pg.Pool, 'query'>;

function newPool(config: pg.PoolConfig, label: string): pg.Pool {
  const pool = new pg.Pool(config);
  // 閒置連線斷掉（例如 RDS Multi-AZ 容錯移轉）時 pg 會在 pool 上丟 error；
  // 沒接的話整個 process 會因為未處理的 'error' 事件而掛掉。
  pool.on('error', (err) => console.error(`pg ${label} pool error: ${err.message}`));
  return pool;
}

export async function createPool(env: Env = process.env): Promise<pg.Pool> {
  return newPool(await poolConfigFromEnv(env), 'api');
}

/** API 查詢用與健康檢查用的兩個連線池；Secrets Manager 只讀一次 */
export async function createPools(env: Env = process.env): Promise<{ api: pg.Pool; health: pg.Pool }> {
  const config = await poolConfigFromEnv(env);
  return { api: newPool(config, 'api'), health: newPool(healthPoolConfig(config), 'health') };
}
