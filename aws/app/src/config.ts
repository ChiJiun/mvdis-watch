/**
 * 環境變數讀取。所有服務都只從環境變數讀設定（見 aws/CONTRACTS.md 第 3 節）。
 */

export type Env = Record<string, string | undefined>;

export function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`缺少環境變數 ${name}`);
  return v;
}

/** 非負整數；空值、非數字、負數都回預設值 */
export function intOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function awsRegion(env: Env): string {
  return env.AWS_REGION || 'us-east-1';
}

/** 本機 LocalStack 用；AWS 上不設 */
export function awsEndpoint(env: Env): string | undefined {
  return env.AWS_ENDPOINT_URL || undefined;
}
