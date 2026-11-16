/**
 * 抓查詢頁與官網保護（契約 §4.2、§4.3）。
 *
 * 網址依任務的 target 選：live 用 MVDIS_LIVE_URL、replay 用 REPLAY_BASE_URL。
 * replay 任務絕不能打到官網 —— preflight() 在發請求前擋一次，resolveTargetUrl() 再擋一次，
 * replay 請求也不跟隨轉址。
 */
import { rocToday } from '../../../../src/mvdis.ts';
import {
  LIVE_HOSTNAME,
  LIVE_TASK_MAX_AGE_MS,
  MVDIS_PATH,
  mvdisFormFields,
  type ScanTarget,
  type ScanTask,
} from '../../../shared/contracts.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 官網網域：mvdis.gov.tw 本身與所有子網域（大小寫、結尾的點都算） */
export function isOfficialHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  return h === LIVE_HOSTNAME || h.endsWith(`.${LIVE_HOSTNAME}`);
}

export type Urls = { liveUrl: string | undefined; replayUrl: string | undefined };

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export type Verdict = { outcome: 'rejected' | 'stale'; reason: string } | null;

/**
 * 契約 §4.2 的三項檢查，依序判斷，任何 HTTP 請求之前做。
 * 回傳 null 表示可以抓。
 */
export function preflight(task: ScanTask, now: number, replayUrl: string | undefined): Verdict {
  if (task.target === 'live' && task.runId !== null) {
    return { outcome: 'rejected', reason: 'live 任務不得帶 runId（實驗只能送 replay 任務）' };
  }
  if (task.target === 'live' && now - task.enqueuedAt > LIVE_TASK_MAX_AGE_MS) {
    return { outcome: 'stale', reason: `live 任務已排隊 ${Math.round((now - task.enqueuedAt) / 1000)} 秒，超過 ${LIVE_TASK_MAX_AGE_MS / 1000} 秒不抓` };
  }
  if (task.target === 'replay') {
    if (!replayUrl) return { outcome: 'rejected', reason: 'REPLAY_BASE_URL 未設定，拒絕 replay 任務' };
    let u: URL;
    try {
      u = new URL(replayUrl);
    } catch {
      return { outcome: 'rejected', reason: `REPLAY_BASE_URL 不是合法網址：${replayUrl}` };
    }
    if (!HTTP_PROTOCOLS.has(u.protocol)) return { outcome: 'rejected', reason: `REPLAY_BASE_URL 只能是 http(s)：${u.protocol}` };
    if (isOfficialHost(u.hostname)) return { outcome: 'rejected', reason: `REPLAY_BASE_URL 指向官網（${u.hostname}），拒絕 replay 任務` };
  }
  return null;
}

export class TargetGuardError extends Error {}

/** 決定完整網址；replay 指向官網或未設定、live 未設定 MVDIS_LIVE_URL 時丟 TargetGuardError（第二道防線） */
export function resolveTargetUrl(target: ScanTarget, urls: Urls): URL {
  if (target === 'replay') {
    if (!urls.replayUrl) throw new TargetGuardError('REPLAY_BASE_URL 未設定');
    const u = new URL(MVDIS_PATH, urls.replayUrl);
    if (!HTTP_PROTOCOLS.has(u.protocol)) throw new TargetGuardError(`REPLAY_BASE_URL 只能是 http(s)：${u.protocol}`);
    if (isOfficialHost(u.hostname)) throw new TargetGuardError(`REPLAY_BASE_URL 指向官網（${u.hostname}）`);
    return u;
  }
  // 沒設定就不抓（fail-closed）：避免本機忘了設 MVDIS_LIVE_URL 時從開發機打官網
  if (!urls.liveUrl) throw new TargetGuardError('MVDIS_LIVE_URL 未設定，拒絕 live 任務');
  return new URL(MVDIS_PATH, urls.liveUrl);
}

export type FetchInput = {
  target: ScanTarget;
  urls: Urls;
  licenseType: string;
  lv1: string;
  dmvNo: string;
  now: Date;
  timeoutMs: number;
};

export type FetchResult = { status: number; html: string; url: string };

export type FetchFn = typeof fetch;

export async function fetchLocations(input: FetchInput, fetchFn: FetchFn = fetch): Promise<FetchResult> {
  const url = resolveTargetUrl(input.target, input.urls);
  const body = new URLSearchParams(
    mvdisFormFields({ licenseType: input.licenseType, lv1: input.lv1, dmvNo: input.dmvNo, dateStr: rocToday(input.now) }),
  );
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: url.toString(),
      'Accept-Language': 'zh-TW,zh;q=0.9',
    },
    body,
    // replay 站若回 3xx 轉址，不能被它帶去官網
    redirect: input.target === 'replay' ? 'error' : 'follow',
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  return { status: res.status, html: await res.text(), url: url.toString() };
}
