/**
 * PostgreSQL 連線池。
 *
 * 設定來源（見 aws/CONTRACTS.md 第 3 節）：
 *   - `DATABASE_URL` 有值就直接用（本機開發、測試）。
 *   - 否則用 `DB_HOST`／`DB_PORT`／`DB_NAME`，帳密從 Secrets Manager 的 `DB_SECRET_ARN` 取
 *     （secret 內容為 JSON `{"username":"…","password":"…"}`）。
 *
 * api 自己的選用變數（不在契約裡，infra 不設也能跑）：
 *   - `DB_POOL_MAX`：每台 EC2 的連線池上限，預設 10。ASG 擴到 N 台時 RDS 會有 N × DB_POOL_MAX 條連線，
 *     要和 RDS 機型的 max_connections 一起算。
 *   - `DB_SSL`：`disable`／`no-verify`／`verify`。走 DB_HOST 路徑時預設 `no-verify`
 *     （RDS PostgreSQL 15 起預設 rds.force_ssl=1，不開 SSL 連不上）；走 DATABASE_URL 時預設 `disable`，
 *     要加密就在 URL 帶 sslmode 或設這個變數。
 *   - `DB_STATEMENT_TIMEOUT_MS`：單一查詢逾時，預設 10000。
 */
import pg from 'pg';

/** pg 的型別 OID */
const OID = { BOOL: 16, INT8: 20, NUMERIC: 1700, DATE: 1082 } as const;

/**
 * 讓 Postgres 的回傳值長得和原型（D1／SQLite）一模一樣：
 *   - BIGINT（epoch 毫秒、COUNT、SUM、BIGSERIAL）→ JS number。epoch 毫秒遠小於 2^53，不會失真。
 *   - DATE → 原樣的 `YYYY-MM-DD` 字串，不要變成 JS Date（會被時區位移）。
 *   - BOOLEAN → 0／1，原型的旗標欄位是 INTEGER。
 */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    switch (oid) {
      case OID.INT8:
      case OID.NUMERIC:
        return (v: string) => Number(v);
      case OID.DATE:
        return (v: string) => v;
      case OID.BOOL:
        return (v: string) => (v === 't' ? 1 : 0);
      default:
        return pg.types.getTypeParser(oid, format as 'text');
    }
  },
};

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

/** 依環境變數組出連線池設定。抽出來是為了讓測試能直接檢查，不必真的連線。 */
export async function poolConfigFromEnv(env: Env = process.env): Promise<pg.PoolConfig> {
  const common: pg.PoolConfig = {
    max: intEnv(env, 'DB_POOL_MAX', 10),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: intEnv(env, 'DB_STATEMENT_TIMEOUT_MS', 10000),
    application_name: 'mvdis-api',
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

export type Queryable = Pick<pg.Pool, 'query'>;

export async function createPool(env: Env = process.env): Promise<pg.Pool> {
  const pool = new pg.Pool(await poolConfigFromEnv(env));
  // 閒置連線斷掉（例如 RDS Multi-AZ 容錯移轉）時 pg 會在 pool 上丟 error；
  // 沒接的話整個 process 會因為未處理的 'error' 事件而掛掉。
  pool.on('error', (err) => console.error('pg pool error', err.message));
  return pool;
}
