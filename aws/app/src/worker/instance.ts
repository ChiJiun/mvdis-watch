/**
 * 用 IMDSv2 取 EC2 instance id 與可用區域，寫進 scan_task_log（E2 用來確認故障區的任務被別區接手）。
 * 本機或非 EC2 環境 IMDS 連不到，就退回 WORKER_ID／WORKER_AZ 或主機名稱。
 */
import { hostname } from 'node:os';
import type { Env } from '../config.ts';

export type WorkerIdentity = { workerId: string; az: string | null };

const IMDS = 'http://169.254.169.254';

export async function detectIdentity(env: Env, fetchFn: typeof fetch = fetch): Promise<WorkerIdentity> {
  if (env.WORKER_ID) return { workerId: env.WORKER_ID, az: env.WORKER_AZ || null };
  try {
    const tokenRes = await fetchFn(`${IMDS}/latest/api/token`, {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      signal: AbortSignal.timeout(1000),
    });
    if (!tokenRes.ok) throw new Error(`IMDS token HTTP ${tokenRes.status}`);
    const token = await tokenRes.text();
    const get = async (path: string) => {
      const r = await fetchFn(`${IMDS}/latest/meta-data/${path}`, {
        headers: { 'X-aws-ec2-metadata-token': token },
        signal: AbortSignal.timeout(1000),
      });
      if (!r.ok) throw new Error(`IMDS ${path} HTTP ${r.status}`);
      return (await r.text()).trim();
    };
    const [workerId, az] = await Promise.all([get('instance-id'), get('placement/availability-zone')]);
    return { workerId, az };
  } catch {
    return { workerId: `local-${hostname()}`, az: env.WORKER_AZ || null };
  }
}
