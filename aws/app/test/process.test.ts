/**
 * worker 處理流程，對真 Postgres 跑（TEST_DATABASE_URL 沒設就整檔跳過）。
 * S3、SNS、HTTP 都換成假的，記錄呼叫內容。DB 型別套用契約 §7.1（bool → 0/1、bigint → Number）。
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PRUNE_AFTER_EMPTY, processMessage, type Deps } from '../src/worker/process.ts';
import { LIVE_TASK_MAX_AGE_MS, taipeiIsoDate, type ReleasedEvent, type ScanTask } from '../../shared/contracts.ts';
import type { DbSchemas } from '../src/db.ts';
import { createTestPool, TEST_DATABASE_URL } from './helpers/pg.ts';
import { daysFromNow, locationsHtml, type FixtureRow } from './helpers/fixture.ts';

const skip = !TEST_DATABASE_URL ? 'TEST_DATABASE_URL 未設定，略過需要 Postgres 的測試' : false;

describe('worker processMessage（Postgres）', { skip }, () => {
  let pool: pg.Pool;
  let schemas: DbSchemas;
  let R: string; // replay 任務的資料 schema（正式環境的 replay）
  let drop: () => Promise<void>;
  let clock: number;
  let html: string;
  let status: number;
  let fetchCalls: string[];
  let puts: Array<{ key: string; body: Uint8Array | string; contentType: string }>;
  let published: ReleasedEvent[];
  let metrics: Array<Record<string, unknown>>;

  const D1 = daysFromNow(10);
  const D2 = daysFromNow(11);

  before(async () => {
    ({ pool, schemas, drop } = await createTestPool());
    R = schemas.replay;
  });
  after(async () => {
    await drop?.();
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE slot, slot_event, scan_log, scan_task_log, ${R}.slot, ${R}.slot_event, ${R}.scan_log`);
    clock = Date.now();
    status = 200;
    html = locationsHtml([]);
    fetchCalls = [];
    puts = [];
    published = [];
    metrics = [];
  });

  const deps = (over: Partial<Deps> = {}): Deps => ({
    pool,
    schemas,
    fetchFn: (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      clock += 25; // 模擬抓取耗時
      return new Response(html, { status });
    }) as typeof fetch,
    putObject: async (key, body, contentType) => {
      puts.push({ key, body, contentType });
    },
    publishReleased: async (events) => {
      published.push(...events);
    },
    metrics: (line) => metrics.push(JSON.parse(line)),
    log: () => {},
    identity: { workerId: 'i-test', az: 'us-east-1a' },
    urls: { liveUrl: 'http://live.test:8080', replayUrl: 'http://replay.test:8080' },
    fetchTimeoutMs: 1000,
    now: () => clock,
    ...over,
  });

  const task = (over: Partial<ScanTask> = {}): ScanTask => ({
    v: 1,
    taskId: randomUUID(),
    licenseType: '3',
    lv1: '60',
    dmvNo: '63',
    tier: 'hot',
    target: 'live',
    runId: null,
    enqueuedAt: clock - 1000,
    ...over,
  });

  const run = (t: ScanTask, d: Deps = deps(), receiveCount = 1) => processMessage(JSON.stringify(t), receiveCount, d);
  const setPage = (rows: FixtureRow[]) => {
    html = locationsHtml(rows);
  };
  const taskRow = async (taskId: string) =>
    (await pool.query('SELECT * FROM scan_task_log WHERE task_id = $1', [taskId])).rows[0];
  const count = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;

  test('第一次掃描：寫入 slot、new 事件、scan_log、scan_task_log（committed_at、finished_at），原始頁與事件放 S3', async () => {
    setPage([
      { date: D1, session: '上午', group: 1, quota: 'full' },
      { date: D1, session: '下午', group: 2, quota: 3 },
    ]);
    const t = task();
    const r = await run(t, deps(), 2);
    assert.deepEqual([r.outcome, r.deleteMessage, r.events], ['ok', true, 2]);
    assert.deepEqual(fetchCalls, ['http://live.test:8080/m3-emv-trn/exm/locations']);

    const slots = await pool.query('SELECT exam_date, sec_key, quota, signup_available, first_seen FROM slot ORDER BY sec_key');
    assert.deepEqual(
      slots.rows.map((x) => [x.exam_date, x.sec_key, x.quota, x.signup_available]),
      [
        [D1, '1:1', -1, 0],
        [D1, '2:2', 3, 1],
      ],
      '§7.1：date 是字串、bool 是 0/1',
    );
    assert.equal(typeof slots.rows[0].first_seen, 'number', '§7.1：bigint 是 Number');

    const ev = await pool.query('SELECT kind, task_id, run_id FROM slot_event');
    assert.equal(ev.rowCount, 2);
    assert.ok(ev.rows.every((e) => e.kind === 'new' && e.task_id === t.taskId));

    const log = (await pool.query('SELECT rows_seen, empty_streak FROM scan_log')).rows[0];
    assert.deepEqual(log, { rows_seen: 2, empty_streak: 0 });

    const tl = await taskRow(t.taskId);
    assert.equal(tl.outcome, 'ok');
    assert.equal(tl.worker_id, 'i-test');
    assert.equal(tl.az, 'us-east-1a');
    assert.equal(tl.receive_count, 2, 'receive_count 取自 SQS ApproximateReceiveCount');
    assert.ok(tl.committed_at && tl.finished_at && tl.finished_at >= tl.committed_at);

    // 契約 §5 步驟 7：dt = taipeiIsoDate(committed_at)，raw 的檔名是 taskId
    const dt = taipeiIsoDate(tl.committed_at);
    const raw = puts.find((p) => p.key.startsWith('raw/'));
    assert.equal(raw!.key, `raw/dt=${dt}/license=3/dmv=63/${t.taskId}.html.gz`);
    const events = puts.find((p) => p.key.startsWith('events/'));
    assert.equal(events!.key, `events/dt=${dt}/${t.taskId}.jsonl`);
    const lines = String(events!.body).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].taskId, t.taskId);
    assert.equal(lines[0].examDate, D1);
    assert.equal(typeof lines[0].at, 'number');
    assert.equal(published.length, 0, 'new 不推 SNS');

    assert.equal(metrics.length, 1);
    assert.deepEqual([metrics[0].Tier, metrics[0].Target, metrics[0].ScanErrors, metrics[0].ScanDurationMs], ['hot', 'live', 0, 25]);
  });

  test('額滿 → 有位：記 released、只發這一筆到 SNS，沒變的不寫', async () => {
    setPage([
      { date: D1, session: '上午', group: 1, quota: 'full' },
      { date: D1, session: '下午', group: 2, quota: 3 },
    ]);
    await run(task());
    clock += 60_000;
    setPage([
      { date: D1, session: '上午', group: 1, quota: 2 },
      { date: D1, session: '下午', group: 2, quota: 3 },
    ]);
    const t2 = task();
    const r = await run(t2);
    assert.deepEqual([r.events, r.released], [1, 1]);
    assert.equal(published.length, 1);
    const p = published[0];
    assert.deepEqual(
      [p.kind, p.target, p.oldQuota, p.newQuota, p.runId, p.taskId, p.examDate],
      ['released', 'live', -1, 2, null, t2.taskId, D1],
    );
    const unchanged = (await pool.query("SELECT updated_at FROM slot WHERE sec_key = '2:2'")).rows[0];
    assert.ok(unchanged.updated_at < clock, '沒變動的列不更新');
    assert.equal(metrics.at(-1)!.ReleasedEvents, 1);
  });

  test('場次消失記 gone 並刪列；filled／decreased 正確分類', async () => {
    setPage([
      { date: D1, session: '上午', group: 1, quota: 5 },
      { date: D1, session: '下午', group: 2, quota: 3 },
      { date: D2, session: '上午', group: 1, quota: 4 },
    ]);
    await run(task());
    clock += 60_000;
    setPage([
      { date: D1, session: '上午', group: 1, quota: 'full' },
      { date: D1, session: '下午', group: 2, quota: 1 },
    ]);
    await run(task());
    const kinds = await pool.query("SELECT kind FROM slot_event WHERE kind <> 'new' ORDER BY kind");
    assert.deepEqual(kinds.rows.map((r) => r.kind), ['decreased', 'filled', 'gone']);
    assert.equal(await count('SELECT count(*) AS n FROM slot'), 2);
  });

  test('冪等：已完成的 taskId 重送，直接刪訊息、不再抓', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 1 }]);
    const t = task();
    await run(t);
    const again = await run(t, deps(), 2);
    assert.deepEqual([again.outcome, again.deleteMessage], ['duplicate', true]);
    assert.equal(fetchCalls.length, 1);
    assert.equal(await count('SELECT count(*) AS n FROM slot_event'), 1, '事件不會重複寫');
    assert.equal((await taskRow(t.taskId)).receive_count, 2);
  });

  test('冪等：已提交但副作用失敗 → 不刪訊息；重送時不再抓，從 slot_event 重建事件補做 S3／SNS 後才寫 finished_at', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 'full' }]);
    await run(task());
    clock += 60_000;
    setPage([{ date: D1, session: '上午', group: 1, quota: 4 }]);
    const t = task();
    const logs: Array<Record<string, unknown>> = [];
    const first = await run(
      t,
      deps({
        putObject: async () => {
          throw new Error('s3 down');
        },
        log: (o) => logs.push(o),
      }),
    );
    assert.deepEqual([first.outcome, first.deleteMessage], ['retry', false]);
    assert.ok(logs.some((l) => String(l.msg).startsWith('side effect failed')));
    let tl = await taskRow(t.taskId);
    assert.ok(tl.committed_at, 'DB 交易已提交');
    assert.equal(tl.finished_at, null, '副作用沒做完不能算完成');
    const fetchesBefore = fetchCalls.length;
    const publishedBefore = published.length;
    const putsBefore = puts.length;

    clock += 60_000;
    const second = await run(t, deps(), 2);
    assert.deepEqual([second.outcome, second.deleteMessage, second.released], ['resumed', true, 1]);
    assert.equal(fetchCalls.length, fetchesBefore, '補做副作用不再打 HTTP');
    assert.equal(published.length, publishedBefore + 1);
    assert.equal(published.at(-1)!.taskId, t.taskId);
    const newPuts = puts.slice(putsBefore).map((p) => p.key);
    assert.deepEqual(
      newPuts.filter((k) => k.startsWith('events/')),
      [`events/dt=${taipeiIsoDate(tl.committed_at)}/${t.taskId}.jsonl`],
      '事件檔補寫到 S3，dt 用 committed_at（和第一次嘗試同一個鍵）',
    );
    assert.ok(!newPuts.some((k) => k.startsWith('raw/')), '補做時已沒有 HTML，略過 raw');
    tl = await taskRow(t.taskId);
    assert.ok(tl.finished_at);
    assert.equal(await count("SELECT count(*) AS n FROM slot_event WHERE kind = 'released'"), 1, 'DB 事件不重複');
  });

  test('冪等：同一個 taskId 兩台同時處理，只有一台提交，事件只寫一次', async () => {
    setPage([
      { date: D1, session: '上午', group: 1, quota: 1 },
      { date: D2, session: '上午', group: 1, quota: 2 },
    ]);
    const t = task();
    const results = await Promise.all([run(t), run(t)]);
    const outcomes = results.map((r) => r.outcome).sort();
    assert.ok(
      JSON.stringify(outcomes) === JSON.stringify(['ok', 'resumed']) || JSON.stringify(outcomes) === JSON.stringify(['duplicate', 'ok']),
      JSON.stringify(outcomes),
    );
    assert.ok(results.every((r) => r.deleteMessage));
    assert.equal(await count('SELECT count(*) AS n FROM slot_event'), 2);
  });

  test('並發：同一組合不同任務同時處理（advisory lock），只會記一次 new 事件', async () => {
    setPage([
      { date: D1, session: '上午', group: 1, quota: 1 },
      { date: D2, session: '上午', group: 1, quota: 2 },
    ]);
    const results = await Promise.all([run(task()), run(task()), run(task())]);
    assert.ok(results.every((r) => r.outcome === 'ok'));
    assert.equal(await count("SELECT count(*) AS n FROM slot_event WHERE kind = 'new'"), 2);
  });

  test('§4.2：live 任務帶 runId → rejected，不發請求，記錄後刪訊息', async () => {
    const t = task({ target: 'live', runId: 'exp-1' });
    const r = await run(t);
    assert.deepEqual([r.outcome, r.deleteMessage], ['rejected', true]);
    assert.equal(fetchCalls.length, 0);
    const tl = await taskRow(t.taskId);
    assert.equal(tl.outcome, 'rejected');
    assert.ok(tl.finished_at);
    assert.equal(tl.committed_at, null);
  });

  test('§4.2：live 任務排隊超過 120 秒 → stale，不發請求；未超過就照常打 MVDIS_LIVE_URL', async () => {
    const old = task({ target: 'live', enqueuedAt: clock - LIVE_TASK_MAX_AGE_MS - 1 });
    const r = await run(old);
    assert.deepEqual([r.outcome, r.deleteMessage], ['stale', true]);
    assert.equal(fetchCalls.length, 0);
    assert.equal((await taskRow(old.taskId)).outcome, 'stale');

    const fresh = await run(task({ target: 'live', enqueuedAt: clock - 5_000 }));
    assert.equal(fresh.outcome, 'ok');
    assert.deepEqual(fetchCalls, ['http://live.test:8080/m3-emv-trn/exm/locations']);
  });

  test('§4.2：replay 不打官網 —— REPLAY_BASE_URL 未設定或指向官網時 rejected，一個請求都不發', async () => {
    for (const replayUrl of ['https://www.mvdis.gov.tw', 'https://WWW.MVDIS.GOV.TW/', undefined]) {
      const t = task({ target: 'replay', runId: 'e1' });
      const r = await run(t, deps({ urls: { liveUrl: 'https://www.mvdis.gov.tw', replayUrl } }));
      assert.deepEqual([r.outcome, r.deleteMessage], ['rejected', true], String(replayUrl));
      assert.equal((await taskRow(t.taskId)).outcome, 'rejected');
    }
    assert.equal(fetchCalls.length, 0);
    assert.equal(await count('SELECT count(*) AS n FROM scan_log'), 0, '不污染上游健康度');
    assert.equal(await count(`SELECT count(*) AS n FROM ${R}.scan_log`), 0);
  });

  test('§4.2：replay 任務不受 120 秒限制', async () => {
    const r = await run(task({ target: 'replay', runId: 'e1', enqueuedAt: clock - 3600_000 }));
    assert.equal(r.outcome, 'ok');
  });

  test('降頻：長期沒場次的組合 24 小時內跳過、不發請求；replay 任務不套用降頻', async () => {
    for (const s of [schemas.live, R]) {
      await pool.query(
        `INSERT INTO ${s}.scan_log (license_type, dmv_no, last_ok, rows_seen, empty_streak) VALUES ('3', '63', $1, 0, $2)`,
        [clock - 3600_000, PRUNE_AFTER_EMPTY],
      );
    }
    const t = task();
    const r = await run(t);
    assert.deepEqual([r.outcome, r.deleteMessage], ['skipped', true]);
    assert.equal(fetchCalls.length, 0);
    const tl = await taskRow(t.taskId);
    assert.equal(tl.outcome, 'skipped');
    assert.ok(tl.finished_at);

    const exp = await run(task({ target: 'replay', runId: 'e1' }));
    assert.equal(exp.outcome, 'ok', 'replay 就算 replay schema 的 scan_log 符合降頻條件也照抓');
    assert.deepEqual(fetchCalls, ['http://replay.test:8080/m3-emv-trn/exm/locations']);
  });

  test('降頻：超過 24 小時就複查；連續空結果會累加 empty_streak', async () => {
    await pool.query(
      `INSERT INTO scan_log (license_type, dmv_no, last_ok, rows_seen, empty_streak) VALUES ('3', '63', $1, 0, $2)`,
      [clock - 25 * 3600_000, PRUNE_AFTER_EMPTY],
    );
    const r = await run(task());
    assert.equal(r.outcome, 'ok');
    assert.equal((await pool.query('SELECT empty_streak FROM scan_log')).rows[0].empty_streak, PRUNE_AFTER_EMPTY + 1);
  });

  test('上游錯誤：記 scan_log 錯誤與 outcome=error，照樣刪訊息（不讓 SQS 立刻重打）', async () => {
    status = 502;
    html = 'Bad Gateway';
    const t = task();
    const r = await run(t);
    assert.deepEqual([r.outcome, r.deleteMessage], ['error', true]);
    const log = (await pool.query('SELECT last_error, last_ok, empty_streak FROM scan_log')).rows[0];
    assert.deepEqual(log, { last_error: 'HTTP 502', last_ok: null, empty_streak: 0 }, '錯誤不能算成空結果，否則會誤觸降頻');
    const tl = await taskRow(t.taskId);
    assert.deepEqual([tl.outcome, tl.error], ['error', 'HTTP 502']);
    assert.ok(tl.committed_at && tl.finished_at);
    assert.equal(metrics.at(-1)!.ScanErrors, 1);
    assert.equal(puts.length, 0, 'outcome=error 不寫 raw，也沒有事件');
  });

  test('上游錯誤：頁面結構不對（解析失敗）也算 error', async () => {
    html = '<html>維護中</html>';
    const r = await run(task());
    assert.equal(r.outcome, 'error');
    assert.match(r.error!, /trnTable/);
    assert.equal(await count('SELECT count(*) AS n FROM slot'), 0);
  });

  test('舊快照不能蓋掉新資料：晚抓的先提交時，早抓的結果不套用', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 9 }]);
    await run(task());
    clock -= 10_000; // 讓下一次抓取的時間點早於已寫入的 last_ok
    setPage([{ date: D1, session: '上午', group: 1, quota: 'full' }]);
    const t = task();
    const r = await run(t);
    assert.deepEqual([r.outcome, r.events], ['ok', 0]);
    assert.equal((await pool.query('SELECT quota FROM slot')).rows[0].quota, 9);
    assert.match((await taskRow(t.taskId)).error, /stale snapshot/);
  });

  test('格式錯誤的訊息（JSON、v、taskId 不是 UUID）記 log 後直接刪，不寫 DB', async () => {
    for (const body of ['not json', '{"v":2}', JSON.stringify({ ...task(), taskId: 'not-a-uuid' })]) {
      const r = await processMessage(body, 1, deps());
      assert.deepEqual([r.outcome, r.deleteMessage], ['invalid', true], body);
    }
    assert.equal(await count('SELECT count(*) AS n FROM scan_task_log'), 0);
    assert.equal(fetchCalls.length, 0);
  });

  test('MVDIS_LIVE_URL 未設定時 live 任務記 rejected、不發請求（fail-closed，不會默默打官網）', async () => {
    const t = task();
    const r = await run(t, deps({ urls: { liveUrl: undefined, replayUrl: 'http://replay.test:8080' } }));
    assert.deepEqual([r.outcome, r.deleteMessage], ['rejected', true]);
    assert.equal(fetchCalls.length, 0);
    assert.equal((await taskRow(t.taskId)).outcome, 'rejected');
  });

  test('同一頁出現重複的 (exam_date, sec_key)：保留最後一筆，不會因 ON CONFLICT 變成毒訊息', async () => {
    setPage([
      { date: D1, session: '上午', group: 1, quota: 2 },
      { date: D1, session: '上午', group: 1, quota: 3 },
    ]);
    const r = await run(task());
    assert.deepEqual([r.outcome, r.deleteMessage, r.events], ['ok', true, 1]);
    assert.deepEqual((await pool.query('SELECT quota FROM slot')).rows, [{ quota: 3 }]);
  });

  test('§7.3：replay 任務的 slot／slot_event／scan_log 寫進 replay schema，不影響正式資料與 live 的 diff', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 'full' }]);
    await run(task()); // live：正式資料記下額滿
    setPage([{ date: D1, session: '上午', group: 1, quota: 2 }]);
    clock += 1000;
    const rp = task({ target: 'replay', runId: 'e3' });
    const r = await run(rp);
    assert.deepEqual([r.outcome, r.events, r.released], ['ok', 1, 0], 'replay schema 原本是空的，只會是 new');
    assert.deepEqual(
      (await pool.query(`SELECT kind, run_id FROM ${R}.slot_event`)).rows,
      [{ kind: 'new', run_id: 'e3' }],
    );
    assert.equal(await count(`SELECT count(*) AS n FROM ${R}.scan_log`), 1);
    assert.equal((await taskRow(rp.taskId)).target, 'replay', 'scan_task_log 共用 live 那個 schema');

    // 正式資料沒被 replay 動到：slot 仍是額滿，live 再抓到額滿不會有任何事件
    assert.deepEqual((await pool.query('SELECT quota FROM slot')).rows, [{ quota: -1 }]);
    assert.equal(await count('SELECT count(*) AS n FROM slot_event WHERE run_id IS NOT NULL'), 0);
    setPage([{ date: D1, session: '上午', group: 1, quota: 'full' }]);
    clock += 1000;
    const again = await run(task());
    assert.deepEqual([again.outcome, again.events], ['ok', 0]);
    assert.equal(published.length, 0, '沒有假的 released');
  });

  test('§7.3：replay 任務補做副作用時讀 replay schema 的 slot_event', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 'full' }]);
    await run(task({ target: 'replay', runId: 'e3' }));
    setPage([{ date: D1, session: '上午', group: 1, quota: 4 }]);
    clock += 1000;
    const t = task({ target: 'replay', runId: 'e3' });
    const first = await run(
      t,
      deps({
        publishReleased: async () => {
          throw new Error('sns down');
        },
      }),
    );
    assert.deepEqual([first.outcome, first.deleteMessage], ['retry', false]);
    const second = await run(t, deps(), 2);
    assert.deepEqual([second.outcome, second.released], ['resumed', 1]);
    assert.deepEqual(
      [published.at(-1)!.target, published.at(-1)!.runId, published.at(-1)!.taskId],
      ['replay', 'e3', t.taskId],
    );
  });

  test('R3-1：replay schema 不存在或缺表時拒絕 replay 任務、不發請求，也不會落到正式的表', async () => {
    const partial = `${schemas.live}_partial`;
    await pool.query(`CREATE SCHEMA ${partial}`);
    await pool.query(`CREATE TABLE ${partial}.slot (LIKE ${schemas.live}.slot INCLUDING ALL)`);
    await pool.query(`CREATE TABLE ${partial}.slot_event (LIKE ${schemas.live}.slot_event INCLUDING ALL)`);
    try {
      setPage([{ date: D1, session: '上午', group: 1, quota: 2 }]);
      for (const [replay, missing] of [
        [`${schemas.live}_nope`, /_nope\.slot, .*_nope\.slot_event, .*_nope\.scan_log/],
        [partial, /_partial\.scan_log/],
      ] as const) {
        const t = task({ target: 'replay', runId: 'e1' });
        const r = await run(t, deps({ schemas: { live: schemas.live, replay } }));
        assert.deepEqual([r.outcome, r.deleteMessage], ['rejected', true], replay);
        assert.match(r.error!, missing);
        assert.equal((await taskRow(t.taskId)).outcome, 'rejected');
      }
      assert.equal(fetchCalls.length, 0);
      for (const tbl of ['slot', 'slot_event', 'scan_log']) {
        assert.equal(await count(`SELECT count(*) AS n FROM ${tbl}`), 0, `正式的 ${tbl} 沒被寫入`);
      }
      assert.equal(await count(`SELECT count(*) AS n FROM ${partial}.slot`), 0);
    } finally {
      await pool.query(`DROP SCHEMA ${partial} CASCADE`);
    }
  });

  test('R3-1：schema 對應拿到未知 target 或 undefined 時丟例外，不插值成 undefined', async () => {
    const t = task({ target: 'replay', runId: 'e1' });
    await assert.rejects(
      run(t, deps({ schemas: { live: schemas.live, replay: undefined } as unknown as DbSchemas })),
      /不合法的 schema 名稱：undefined/,
    );
    await assert.rejects(
      run(task({ target: 'replay', runId: 'e1' }), deps({ schemas: { live: schemas.live } as unknown as DbSchemas })),
      /未知的 target：replay/,
    );
    assert.equal(fetchCalls.length, 0);
  });

  /** 包一層連線池：每次 pool.query 前先呼叫 before(sql)，用來在兩個步驟之間插入「別台 worker」的動作 */
  const racingPool = (before: (sql: string) => Promise<void>): pg.Pool =>
    new Proxy(pool, {
      get(target, key) {
        if (key === 'query') {
          return async (sql: string, params?: unknown[]) => {
            await before(String(sql));
            return target.query(sql, params);
          };
        }
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });

  test('R3-2：判 stale 的 UPDATE 影響 0 列（別台剛提交）→ 不直接刪，改成補做副作用', async () => {
    const t = task({ enqueuedAt: clock - LIVE_TASK_MAX_AGE_MS - 1 });
    let raced = false;
    const p = racingPool(async (sql) => {
      if (!raced && sql.includes('SET outcome = $2')) {
        raced = true; // 「A 台」在 B 讀完 committed_at 之後、寫 stale 之前提交，並留下一筆 released 事件
        await pool.query(
          `INSERT INTO slot_event (license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at, task_id)
           VALUES ('3', '63', $1, '1:1', 'released', -1, 2, $2, $3)`,
          [D1, clock, t.taskId],
        );
        await pool.query(`UPDATE scan_task_log SET committed_at = $2, outcome = 'ok' WHERE task_id = $1`, [t.taskId, clock]);
      }
    });
    const r = await run(t, deps({ pool: p }));
    assert.ok(raced);
    assert.deepEqual([r.outcome, r.deleteMessage, r.released], ['resumed', true, 1]);
    assert.equal(fetchCalls.length, 0);
    assert.equal(published.length, 1, 'A 台的 released 由 B 補發');
    const tl = await taskRow(t.taskId);
    assert.deepEqual([tl.outcome, typeof tl.finished_at], ['ok', 'number'], '不會被改成 stale');
  });

  test('R3-2：交易前別台已判 stale（finished 而未 committed）→ rollback、刪訊息，不提交成 ok', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 2 }]);
    const t = task();
    const r = await run(
      t,
      deps({
        fetchFn: (async () => {
          fetchCalls.push('live');
          // 抓取期間，「B 台」把同一個任務判成 stale
          await pool.query(`UPDATE scan_task_log SET outcome = 'stale', finished_at = $2 WHERE task_id = $1`, [t.taskId, clock]);
          return new Response(html, { status: 200 });
        }) as typeof fetch,
      }),
    );
    assert.deepEqual([r.outcome, r.deleteMessage], ['duplicate', true]);
    const tl = await taskRow(t.taskId);
    assert.deepEqual([tl.outcome, tl.committed_at], ['stale', null], 'finished 早於 committed 的狀態不會出現');
    assert.equal(await count('SELECT count(*) AS n FROM slot'), 0);
    assert.deepEqual([puts.length, published.length], [0, 0]);
  });

  test('R3-4：advisory lock 的鍵帶 target，live 持有同組合的鎖時 replay 任務不必等', async () => {
    const holder = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('live|3|63'))");
      setPage([{ date: D1, session: '上午', group: 1, quota: 2 }]);
      const r = await Promise.race([
        run(task({ target: 'replay', runId: 'e4' })),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('replay 任務在等 live 的鎖')), 5000)),
      ]);
      assert.equal(r.outcome, 'ok');
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
  });

  test('資料庫錯誤會丟例外（呼叫端不刪訊息，讓 SQS 重送）', async () => {
    const broken = {
      query: async () => {
        throw new Error('db down');
      },
    } as unknown as pg.Pool;
    await assert.rejects(run(task(), deps({ pool: broken })), /db down/);
  });
});
