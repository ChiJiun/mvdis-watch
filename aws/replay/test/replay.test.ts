/**
 * Replay 模擬站的單元與整合測試。核心要證明的是：
 *   1. 產生的 HTML 能被原型 src/mvdis.ts 的 parseSlots 正確解析（360 組全部）
 *   2. 產生的列和官網真實頁面的列逐字相同（同格式，不只是「解析得出來」）
 *   3. 擾動、重設、事件紀錄與 HTTP 介面符合契約第 8 節
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { parseSlots, FULL } from '../../../src/mvdis.ts';
import { allCombos } from '../../../src/catalogue.ts';
import { DEFAULT_CONFIG, ReplayState, renderPage, renderRow, splitTemplate, type SlotState } from '../src/generator.ts';
import { createReplayServer, LOCATIONS_PATH, validateReset } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';

const RAW = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'raw');
const readFixture = (name: string) => readFileSync(join(RAW, `${name}.html`), 'utf8');
const NOW = Date.UTC(2026, 10, 16, 4, 0, 0); // 2026-11-16 12:00 台灣時間

const tpl = splitTemplate(readFixture('available'));

test('真實 fixture 本身能被 parseSlots 解析（模板沒壞）', () => {
  const avail = parseSlots(readFixture('available'), '3', '63');
  assert.ok(avail.length > 0);
  assert.ok(avail.some((s) => s.quota > 0));
  assert.deepEqual(parseSlots(readFixture('empty'), 'H', '83'), []);
  assert.ok(parseSlots(readFixture('full'), '3', '41').every((s) => s.quota === FULL));
});

test('360 組產生的頁面都能被 parseSlots 正確解析，欄位與產生器一致', () => {
  const state = new ReplayState(DEFAULT_CONFIG, NOW);
  assert.equal(state.combos.size, 360);
  let rows = 0;
  for (const c of allCombos()) {
    const combo = state.lookup(c.licenseType, c.lv1, c.dmvNo);
    assert.ok(combo, `${c.licenseType}|${c.dmvNo} 不存在`);
    const parsed = parseSlots(renderPage(tpl, combo.slots), c.licenseType, c.dmvNo);
    assert.equal(parsed.length, combo.slots.length, `${c.licenseType}|${c.dmvNo} 列數不符`);
    const keys = new Set(parsed.map((p) => `${p.examDate}|${p.secKey}`));
    assert.equal(keys.size, parsed.length, '同一組合內 examDate+secKey 撞鍵');
    parsed.forEach((p, i) => {
      const s = combo.slots[i];
      assert.equal(p.examDate, s.examDate);
      assert.equal(p.rocDate, s.rocDate);
      assert.equal(p.weekday, s.weekday);
      assert.equal(p.secKey, s.secKey);
      assert.ok(!p.secKey.startsWith('h:'), '退回雜湊鍵代表說明文字格式不對');
      assert.equal(p.quota, s.quota);
      assert.equal(p.signupAvailable, s.quota > 0);
      assert.equal(p.session, s.session);
      assert.equal(p.group, s.group);
      if (s.quota > 0) {
        assert.equal(p.secId, s.session === '上午' ? '1' : '2');
        assert.equal(p.divId, String(s.group));
      }
    });
    rows += parsed.length;
  }
  assert.ok(rows > 3000, `總列數 ${rows} 太少`);
});

/** 從真實頁面切出第一個「額滿」列與第一個「有位」列（含 <tr>…</tr>） */
function realRows(html: string): { full: string; avail: string } {
  const i = html.indexOf('id="trnTable"');
  const body = html.slice(html.indexOf('<tbody>', i) + 7, html.indexOf('</tbody>', i));
  const rows = body.split('<tr>').slice(1).map((r) => '<tr>' + r.slice(0, r.indexOf('</tr>') + 5));
  return { full: rows.find((r) => !r.includes('preAdd'))!, avail: rows.find((r) => r.includes('preAdd'))! };
}

test('renderRow 的輸出和官網真實列逐字相同（額滿列與有位列）', () => {
  const { full, avail } = realRows(readFixture('available'));
  for (const real of [full, avail]) {
    const p = parseSlots(`<table id="trnTable"><tbody>${real}</table>`, '3', '63')[0];
    const note = real.match(/<br>\r\n\t+([\s\S]*?)\r\n\t+<\/td>/)![1];
    const slot: SlotState = {
      examDate: p.examDate,
      rocDate: p.rocDate,
      weekday: p.weekday,
      session: p.session as SlotState['session'],
      group: p.group!,
      secKey: p.secKey,
      note,
      capacity: 30,
      quota: p.quota,
    };
    assert.equal(renderRow(slot), real);
  }
});

test('空組合的頁面和官網「無場次」頁面的表格段逐字相同', () => {
  const empty = readFixture('empty');
  const seg = (h: string) => {
    const t = h.indexOf('id="trnTable"');
    return h.slice(h.indexOf('<tbody>', t), h.indexOf('</tbody>', t) + 8);
  };
  assert.equal(seg(renderPage(tpl, [])), seg(empty));
});

test('產生的整頁 HTML 和真實頁面一樣全是 CRLF（不混用 LF）', () => {
  const state = new ReplayState(DEFAULT_CONFIG, NOW);
  const html = renderPage(tpl, state.lookup('3', '60', '63')!.slots);
  assert.equal((html.match(/(?<!\r)\n/g) ?? []).length, 0);
  // 模板若被 git autocrlf 轉成 LF，這裡會先失敗（見 aws/replay/.gitattributes）
  assert.ok(readFixture('available').includes('\r\n'));
});

test('同一個 seed 產生相同狀態；reset 會還原', () => {
  const a = new ReplayState(DEFAULT_CONFIG, NOW);
  const b = new ReplayState(DEFAULT_CONFIG, NOW);
  assert.deepEqual([...a.combos.entries()], [...b.combos.entries()]);
  const snapshot = JSON.stringify([...a.combos.entries()]);
  a.reset({ flipProb: 1 }, NOW);
  for (const c of a.combos.values()) a.perturbOnRequest(c, NOW);
  assert.notEqual(JSON.stringify([...a.combos.entries()]), snapshot);
  a.reset({ flipProb: DEFAULT_CONFIG.flipProb }, NOW);
  assert.equal(JSON.stringify([...a.combos.entries()]), snapshot);
  assert.equal(a.events.length, 0);
  const c = new ReplayState({ ...DEFAULT_CONFIG, seed: 1 }, NOW);
  assert.notEqual(JSON.stringify([...c.combos.entries()]), snapshot);
});

test('flipProb=1 時每次請求翻轉該組合全部場次，並記錄 released/filled 事件', () => {
  const state = new ReplayState({ ...DEFAULT_CONFIG, flipProb: 1 }, NOW);
  const combo = [...state.combos.values()].find((c) => c.slots.some((s) => s.quota < 0) && c.slots.some((s) => s.quota > 0))!;
  const before = combo.slots.map((s) => s.quota);
  state.perturbOnRequest(combo, NOW + 1);
  combo.slots.forEach((s, i) => assert.equal(s.quota > 0, before[i] < 0));
  assert.equal(state.events.length, combo.slots.length);
  for (const e of state.events) {
    assert.equal(e.kind, e.oldQuota < 0 ? 'released' : 'filled');
    if (e.kind === 'released') assert.ok(e.newQuota > 0);
    else assert.equal(e.newQuota, -1);
  }
  // 解析結果要反映翻轉
  const parsed = parseSlots(renderPage(tpl, combo.slots), combo.licenseType, combo.dmvNo);
  parsed.forEach((p, i) => assert.equal(p.quota > 0, before[i] < 0));
});

test('flipProb=0 時名額不變；clock tick 翻轉指定數量', () => {
  const state = new ReplayState({ ...DEFAULT_CONFIG, flipProb: 0, flipsPerTick: 7 }, NOW);
  const combo = [...state.combos.values()].find((c) => c.slots.length > 0)!;
  const before = JSON.stringify(combo.slots);
  state.perturbOnRequest(combo, NOW);
  assert.equal(JSON.stringify(combo.slots), before);
  state.tick(NOW + 1000);
  assert.equal(state.events.length, 7);
  assert.ok(state.events.every((e) => e.cause === 'clock'));
  assert.deepEqual(state.eventsAfter(5, null, 100).map((e) => e.seq), [6, 7]);
});

test('事件緩衝超過 maxEvents 時丟掉最舊的', () => {
  const state = new ReplayState({ ...DEFAULT_CONFIG, flipsPerTick: 30, maxEvents: 50 }, NOW);
  state.tick(NOW);
  state.tick(NOW);
  assert.equal(state.events.length, 50);
  assert.equal(state.events[0].seq, 11);
});

test('組合分布合理：有空組合、有有位場次、lv1 對不上回 null', () => {
  const s = new ReplayState(DEFAULT_CONFIG, NOW).stats();
  assert.ok(s.emptyCombos > 10 && s.emptyCombos < 120, `emptyCombos=${s.emptyCombos}`);
  assert.ok(s.available > 0 && s.available < s.slots);
  const state = new ReplayState(DEFAULT_CONFIG, NOW);
  assert.equal(state.lookup('3', '40', '63'), null); // 63 屬於 lv1=60
  assert.equal(state.lookup('Z', '60', '63'), null);
});

test('考試日期從台灣時間今天＋3 天開始、不含星期日', () => {
  const state = new ReplayState(DEFAULT_CONFIG, NOW);
  for (const c of state.combos.values()) {
    for (const s of c.slots) {
      assert.ok(s.examDate >= '2026-11-19', s.examDate);
      assert.notEqual(s.weekday, '星期日');
    }
  }
});

test('validateReset 拒絕未知欄位與越界值', () => {
  assert.deepEqual(validateReset({ flipProb: 0.5, delayMs: 0 }), { flipProb: 0.5, delayMs: 0 });
  assert.throws(() => validateReset({ flipprob: 0.5 }), /未知欄位/);
  assert.throws(() => validateReset({ flipProb: 2 }), /介於/);
  assert.throws(() => validateReset({ tickMs: -1 }), /負數/);
  assert.throws(() => validateReset({ seed: '1' }), /數字/);
  assert.throws(() => validateReset([1]), /JSON 物件/);
});

test('loadConfig 讀環境變數並拒絕不合法值', () => {
  const c = loadConfig({ PORT: '9090', REPLAY_FLIP_PROB: '0.1', REPLAY_DELAY_MS: '0' });
  assert.equal(c.port, 9090);
  assert.equal(c.config.flipProb, 0.1);
  assert.equal(c.options.delayMs, 0);
  assert.equal(c.options.adminToken, null);
  assert.equal(loadConfig({}).port, 8080);
  assert.throws(() => loadConfig({ REPLAY_FLIP_PROB: '1.5' }), /REPLAY_FLIP_PROB/);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
});

async function withServer(
  opts: { adminToken?: string | null; flipProb?: number },
  fn: (base: string) => Promise<void>,
) {
  const state = new ReplayState({ ...DEFAULT_CONFIG, flipProb: opts.flipProb ?? 0 }, NOW);
  const { server } = createReplayServer(state, tpl, { delayMs: 0, jitterMs: 0, adminToken: opts.adminToken ?? null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const form = (licenseType: string, lv1: string, dmvNo: string, method = 'query') =>
  new URLSearchParams({
    method,
    licenseTypeCode: licenseType,
    expectExamDateStr: '1151116',
    _onlyWeekend: 'on',
    dmvNoLv1: lv1,
    dmvNo,
    secDateStr: '',
    secId: '',
    divId: '',
  });

test('HTTP：和原型 querySlots 相同的表單請求，回應可被 parseSlots 解析', async () => {
  await withServer({}, async (base) => {
    const res = await fetch(base + LOCATIONS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form('3', '60', '63'),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.ok(html.length > 50_000, '應回傳整頁大小的 HTML');
    const slots = parseSlots(html, '3', '63');
    const expected = new ReplayState({ ...DEFAULT_CONFIG, flipProb: 0 }, NOW).lookup('3', '60', '63')!.slots;
    assert.equal(slots.length, expected.length);

    // lv1 對不上：照樣 200，但表格是空的
    const bad = await fetch(base + LOCATIONS_PATH, { method: 'POST', body: form('3', '40', '63') });
    assert.equal(bad.status, 200);
    assert.deepEqual(parseSlots(await bad.text(), '3', '63'), []);

    assert.equal((await fetch(base + LOCATIONS_PATH, { method: 'POST', body: form('3', '60', '63', 'dmvOnChange') })).status, 400);
    assert.equal((await fetch(base + LOCATIONS_PATH)).status, 405);
    assert.equal((await fetch(base + '/nope')).status, 404);

    const health = await fetch(base + '/healthz');
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { requests: number }).requests, 2);
  });
});

test('HTTP：/admin/reset 換參數、/admin/events 回傳擾動紀錄', async () => {
  await withServer({}, async (base) => {
    const r = await fetch(base + '/admin/reset', { method: 'POST', body: JSON.stringify({ flipProb: 1 }) });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { config: { flipProb: number } }).config.flipProb, 1);
    await (await fetch(base + LOCATIONS_PATH, { method: 'POST', body: form('3', '60', '63') })).text();
    const ev = (await (await fetch(base + '/admin/events?kind=released')).json()) as { events: Array<{ kind: string }>; lastSeq: number };
    assert.ok(ev.events.length > 0);
    assert.ok(ev.events.every((e) => e.kind === 'released'));
    assert.equal((await fetch(base + '/admin/reset', { method: 'POST', body: '{"flipProb":9}' })).status, 400);
    const stats = (await (await fetch(base + '/admin/stats')).json()) as { requests: number; events: number };
    assert.equal(stats.requests, 1);
  });
});

test('HTTP：設定 REPLAY_ADMIN_TOKEN 時 /admin/* 需要標頭', async () => {
  await withServer({ adminToken: 's3cret' }, async (base) => {
    assert.equal((await fetch(base + '/admin/stats')).status, 401);
    assert.equal((await fetch(base + '/admin/stats', { headers: { 'x-admin-token': 's3cret' } })).status, 200);
    assert.equal((await fetch(base + '/healthz')).status, 200);
  });
});
