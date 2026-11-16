/**
 * ScanTask 的驗證。訊息來源除了 dispatcher 還有 experiments 腳本，
 * 欄位一律對照 catalogue 檢查，避免奇怪的值被當成表單參數送出去。
 */
import { LICENSE_BY_CODE, STATION_BY_NO } from '../../../../src/catalogue.ts';
import { CONTRACT_VERSION, type ScanTask } from '../../../shared/contracts.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTaskError extends Error {}

export function parseTask(body: string): ScanTask {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(body);
  } catch {
    throw new InvalidTaskError('訊息 body 不是 JSON');
  }
  if (!o || typeof o !== 'object') throw new InvalidTaskError('訊息 body 不是物件');
  const fail = (why: string): never => {
    throw new InvalidTaskError(why);
  };

  if (o.v !== CONTRACT_VERSION) fail(`不支援的契約版本 v=${String(o.v)}`);
  if (typeof o.taskId !== 'string' || !UUID_RE.test(o.taskId)) fail('taskId 必須是 UUID');
  if (typeof o.licenseType !== 'string' || !LICENSE_BY_CODE.has(o.licenseType)) fail(`未知的照類 ${String(o.licenseType)}`);
  const st = typeof o.dmvNo === 'string' ? STATION_BY_NO.get(o.dmvNo) : undefined;
  if (!st) fail(`未知的監理站 ${String(o.dmvNo)}`);
  if (o.lv1 !== st!.lv1) fail(`監理站 ${String(o.dmvNo)} 的 lv1 應為 ${st!.lv1}`);
  if (o.tier !== 'hot' && o.tier !== 'cold') fail(`tier 必須是 hot/cold`);
  if (o.target !== 'live' && o.target !== 'replay') fail(`target 必須是 live/replay`);
  if (o.runId !== null && (typeof o.runId !== 'string' || o.runId.length > 200)) fail('runId 必須是 null 或字串');
  if (typeof o.enqueuedAt !== 'number' || !Number.isFinite(o.enqueuedAt)) fail('enqueuedAt 必須是 epoch ms');

  return {
    v: CONTRACT_VERSION,
    taskId: (o.taskId as string).toLowerCase(),
    licenseType: o.licenseType as string,
    lv1: o.lv1 as string,
    dmvNo: o.dmvNo as string,
    tier: o.tier as ScanTask['tier'],
    target: o.target as ScanTask['target'],
    runId: o.runId as string | null,
    enqueuedAt: o.enqueuedAt as number,
  };
}
