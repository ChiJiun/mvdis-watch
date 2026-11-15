/**
 * 抓查詢頁。表單欄位與原型 src/mvdis.ts 的 querySlots 相同，
 * 差別是網址改由 MVDIS_BASE_URL 決定（實驗時指向 VPC 內的 Replay 站），
 * 並在 replay 任務上加了「絕不打官網」的防線。
 */
import { rocToday } from '../../../../src/mvdis.ts';
import { MVDIS_PATH, type ScanTarget } from '../../../shared/contracts.ts';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 官網網域：mvdis.gov.tw 本身與所有子網域 */
export function isOfficialHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  return h === 'mvdis.gov.tw' || h.endsWith('.mvdis.gov.tw');
}

export class TargetGuardError extends Error {}

/**
 * 決定這個任務要打的完整網址。
 * replay 任務的 MVDIS_BASE_URL 一定要明確設定、而且不能是官網；
 * 不符合就丟 TargetGuardError，呼叫端不能發出任何請求。
 */
export function resolveTargetUrl(target: ScanTarget, baseUrl: string | undefined): URL {
  if (target === 'replay') {
    if (!baseUrl) throw new TargetGuardError('replay 任務需要明確設定 MVDIS_BASE_URL（Replay 站位址）');
    const u = new URL(MVDIS_PATH, baseUrl);
    if (isOfficialHost(u.hostname)) {
      throw new TargetGuardError(`replay 任務的 MVDIS_BASE_URL 指向官網（${u.hostname}），拒絕發出請求`);
    }
    return u;
  }
  return new URL(MVDIS_PATH, baseUrl || 'https://www.mvdis.gov.tw');
}

export type FetchInput = {
  target: ScanTarget;
  baseUrl: string | undefined;
  licenseType: string;
  lv1: string;
  dmvNo: string;
  now: Date;
  timeoutMs: number;
};

export type FetchResult = { status: number; html: string; url: string };

export type FetchFn = typeof fetch;

export async function fetchLocations(input: FetchInput, fetchFn: FetchFn = fetch): Promise<FetchResult> {
  const url = resolveTargetUrl(input.target, input.baseUrl);
  const body = new URLSearchParams({
    method: 'query',
    licenseTypeCode: input.licenseType,
    expectExamDateStr: rocToday(input.now),
    _onlyWeekend: 'on',
    dmvNoLv1: input.lv1,
    dmvNo: input.dmvNo,
    secDateStr: '',
    secId: '',
    divId: '',
  });
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
