import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLocations, isOfficialHost, preflight, resolveTargetUrl, TargetGuardError } from '../src/worker/fetch.ts';
import type { ScanTask } from '../../shared/contracts.ts';
import { parseTask, InvalidTaskError } from '../src/worker/task.ts';

test('isOfficialHost：官網本身、子網域、大小寫、結尾的點都算', () => {
  for (const h of ['mvdis.gov.tw', 'www.mvdis.gov.tw', 'WWW.MVDIS.GOV.TW', 'www.mvdis.gov.tw.', 'a.b.mvdis.gov.tw']) {
    assert.equal(isOfficialHost(h), true, h);
  }
  for (const h of ['replay.internal', 'localhost', 'mvdis.gov.tw.evil.com', 'notmvdis.gov.tw', '10.0.1.5']) {
    assert.equal(isOfficialHost(h), false, h);
  }
});

const R = (replayUrl?: string) => ({ liveUrl: 'https://www.mvdis.gov.tw', replayUrl });

test('resolveTargetUrl：replay 用 REPLAY_BASE_URL；沒設或指向官網都拒絕', () => {
  assert.throws(() => resolveTargetUrl('replay', R(undefined)), TargetGuardError);
  assert.throws(() => resolveTargetUrl('replay', R('')), TargetGuardError);
  assert.throws(() => resolveTargetUrl('replay', R('https://www.mvdis.gov.tw')), TargetGuardError);
  assert.throws(() => resolveTargetUrl('replay', R('HTTPS://WWW.MVDIS.GOV.TW:443/')), TargetGuardError);
  assert.throws(() => resolveTargetUrl('replay', R('http://mvdis.gov.tw./x')), TargetGuardError);
  assert.equal(
    resolveTargetUrl('replay', R('http://replay.internal:8080')).toString(),
    'http://replay.internal:8080/m3-emv-trn/exm/locations',
  );
});

test('resolveTargetUrl：live 用 MVDIS_LIVE_URL，沒設時預設官網，絕不會用到 REPLAY_BASE_URL', () => {
  assert.equal(
    resolveTargetUrl('live', { liveUrl: undefined, replayUrl: 'http://replay.internal:8080' }).toString(),
    'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations',
  );
  assert.equal(
    resolveTargetUrl('live', { liveUrl: 'http://127.0.0.1:9999', replayUrl: undefined }).toString(),
    'http://127.0.0.1:9999/m3-emv-trn/exm/locations',
  );
});

const T = (over: Partial<ScanTask> = {}): ScanTask => ({
  v: 1,
  taskId: '0b8a5c1e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
  licenseType: '3',
  lv1: '60',
  dmvNo: '63',
  tier: 'hot',
  target: 'live',
  runId: null,
  enqueuedAt: 1_000_000,
  ...over,
});

test('preflight（契約 §4.2）：live 帶 runId → rejected', () => {
  assert.equal(preflight(T({ runId: 'exp-1' }), 1_000_000, 'http://replay:8080')?.outcome, 'rejected');
});

test('preflight（契約 §4.2）：live 排隊超過 120 秒 → stale；剛好 120 秒還可以抓', () => {
  assert.equal(preflight(T(), 1_000_000 + 120_000, undefined), null);
  assert.equal(preflight(T(), 1_000_000 + 120_001, undefined)?.outcome, 'stale');
});

test('preflight（契約 §4.2）：replay 的 REPLAY_BASE_URL 未設定、壞掉或指向官網 → rejected；replay 不看排隊時間', () => {
  const t = T({ target: 'replay', runId: 'e1' });
  for (const u of [undefined, '', 'not a url', 'https://www.mvdis.gov.tw', 'http://X.MVDIS.GOV.TW.']) {
    assert.equal(preflight(t, 1_000_000, u)?.outcome, 'rejected', String(u));
  }
  assert.equal(preflight(t, 1_000_000 + 3600_000, 'http://10.0.11.20:8080'), null);
});

test('fetchLocations：replay 指向官網時一個請求都不發', async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response('x');
  }) as typeof fetch;
  await assert.rejects(
    fetchLocations(
      { target: 'replay', urls: R('https://www.mvdis.gov.tw'), licenseType: '3', lv1: '60', dmvNo: '63', now: new Date(), timeoutMs: 1000 },
      fake,
    ),
    TargetGuardError,
  );
  assert.equal(calls, 0);
});

test('fetchLocations：表單欄位與原型相同，replay 不跟隨轉址', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), init: init! };
    return new Response('<html/>', { status: 200 });
  }) as typeof fetch;
  const r = await fetchLocations(
    {
      target: 'replay',
      urls: R('http://replay.internal:8080'),
      licenseType: '3',
      lv1: '60',
      dmvNo: '63',
      now: new Date(Date.UTC(2026, 7, 6, 2)),
      timeoutMs: 1000,
    },
    fake,
  );
  assert.equal(r.status, 200);
  assert.ok(seen);
  const s = seen as { url: string; init: RequestInit };
  assert.equal(s.url, 'http://replay.internal:8080/m3-emv-trn/exm/locations');
  assert.equal(s.init.method, 'POST');
  assert.equal(s.init.redirect, 'error');
  const body = new URLSearchParams(String(s.init.body));
  assert.equal(body.get('method'), 'query');
  assert.equal(body.get('licenseTypeCode'), '3');
  assert.equal(body.get('dmvNoLv1'), '60');
  assert.equal(body.get('dmvNo'), '63');
  assert.equal(body.get('expectExamDateStr'), '1150806');
});

test('parseTask：合法任務通過，奇怪的值擋掉', () => {
  const ok = {
    v: 1,
    taskId: '0b8a5c1e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
    licenseType: '3',
    lv1: '60',
    dmvNo: '63',
    tier: 'hot',
    target: 'live',
    runId: null,
    enqueuedAt: 1794761624526,
  };
  assert.equal(parseTask(JSON.stringify(ok)).dmvNo, '63');
  const bad: Array<Record<string, unknown>> = [
    { ...ok, v: 2 },
    { ...ok, taskId: 'nope' },
    { ...ok, licenseType: 'Z' },
    { ...ok, dmvNo: '99' },
    { ...ok, lv1: '20' }, // 豐原站屬於 60
    { ...ok, tier: 'warm' },
    { ...ok, target: 'prod' },
    { ...ok, runId: 5 },
    { ...ok, enqueuedAt: 'x' },
  ];
  for (const b of bad) assert.throws(() => parseTask(JSON.stringify(b)), InvalidTaskError, JSON.stringify(b));
  assert.throws(() => parseTask('not json'), InvalidTaskError);
  assert.throws(() => parseTask('null'), InvalidTaskError);
});
