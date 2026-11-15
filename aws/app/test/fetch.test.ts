import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLocations, isOfficialHost, resolveTargetUrl, TargetGuardError } from '../src/worker/fetch.ts';
import { parseTask, InvalidTaskError } from '../src/worker/task.ts';

test('isOfficialHost：官網本身、子網域、大小寫、結尾的點都算', () => {
  for (const h of ['mvdis.gov.tw', 'www.mvdis.gov.tw', 'WWW.MVDIS.GOV.TW', 'www.mvdis.gov.tw.', 'a.b.mvdis.gov.tw']) {
    assert.equal(isOfficialHost(h), true, h);
  }
  for (const h of ['replay.internal', 'localhost', 'mvdis.gov.tw.evil.com', 'notmvdis.gov.tw', '10.0.1.5']) {
    assert.equal(isOfficialHost(h), false, h);
  }
});

test('resolveTargetUrl：replay 任務沒設或設成官網都拒絕', () => {
  assert.throws(() => resolveTargetUrl('replay', undefined), TargetGuardError);
  assert.throws(() => resolveTargetUrl('replay', ''), TargetGuardError);
  assert.throws(() => resolveTargetUrl('replay', 'https://www.mvdis.gov.tw'), TargetGuardError);
  assert.throws(() => resolveTargetUrl('replay', 'HTTPS://WWW.MVDIS.GOV.TW:443/'), TargetGuardError);
  assert.throws(() => resolveTargetUrl('replay', 'http://mvdis.gov.tw./x'), TargetGuardError);
  assert.equal(
    resolveTargetUrl('replay', 'http://replay.internal:8080').toString(),
    'http://replay.internal:8080/m3-emv-trn/exm/locations',
  );
});

test('resolveTargetUrl：live 任務預設打官網，有設 MVDIS_BASE_URL 就用它', () => {
  assert.equal(resolveTargetUrl('live', undefined).toString(), 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations');
  assert.equal(resolveTargetUrl('live', 'http://127.0.0.1:9999').toString(), 'http://127.0.0.1:9999/m3-emv-trn/exm/locations');
});

test('fetchLocations：replay 指向官網時一個請求都不發', async () => {
  let calls = 0;
  const fake = (async () => {
    calls++;
    return new Response('x');
  }) as typeof fetch;
  await assert.rejects(
    fetchLocations(
      { target: 'replay', baseUrl: 'https://www.mvdis.gov.tw', licenseType: '3', lv1: '60', dmvNo: '63', now: new Date(), timeoutMs: 1000 },
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
      baseUrl: 'http://replay.internal:8080',
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
