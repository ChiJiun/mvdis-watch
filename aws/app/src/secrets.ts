/**
 * Secrets Manager 讀取，獨立成一個檔，notifier 才不會被打包進 pg。
 */
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { awsEndpoint, awsRegion, type Env } from './config.ts';

export async function getSecretJson<T>(env: Env, arn: string): Promise<T> {
  const sm = new SecretsManagerClient({ region: awsRegion(env), endpoint: awsEndpoint(env) });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!r.SecretString) throw new Error(`secret ${arn} 沒有 SecretString`);
  return JSON.parse(r.SecretString) as T;
}
