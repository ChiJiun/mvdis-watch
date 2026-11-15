/**
 * worker 處理流程，對真 Postgres 跑（TEST_DATABASE_URL 沒設就整檔跳過）。
 * S3、SNS、HTTP 都換成假的，記錄呼叫內容。
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { CLAIM_LEASE_MS, PRUNE_AFTER_EMPTY, processMessage, type Deps } from '../src/worker/process.ts';
import type { ReleasedEvent, ScanTask } from '../../shared/contracts.ts';
import { createTestPool, TEST_DATABASE_URL } from './helpers/pg.ts';
import { daysFromNow, locationsHtml, type FixtureRow } from './helpers/fixture.ts';

const skip = !TEST_DATABASE_URL ? 'TEST_DATABASE_URL 未設定，略過需要 Postgres 的測試' : false;

describe('worker processMessage（Postgres）', { skip }, () => {
  let pool: pg.Pool;
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
    ({ pool, drop } = await createTestPool());
  });
  after(async () => {
    await drop?.();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE slot, slot_event, scan_log, scan_task_log');
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
    baseUrl: 'http://replay.test:8080',
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
    target: 'replay',
    runId: null,
    enqueuedAt: clock - 1000,
    ...over,
  });

  const run = (t: ScanTask, d: Deps = deps(), receiveCount = 1) => processMessage(JSON.stringify(t), receiveCount, d);
  const setPage = (rows: FixtureRow[]) => {
    html = locationsHtml(rows);
  };

  test('第一次掃描：寫入 slot、new 事件、scan_log、scan_task_log，原始頁與事件放 S3', async () => {
    setPage([
      { date: D1, session: '上午', group: 1, quota: 'full' },
      { date: D1, session: '下午', group: 2, quota: 3 },
    ]);
    const t = task();
    const r = await run(t);
    assert.equal(r.outcome, 'ok');
    assert.equal(r.deleteMessage, true);
    assert.equal(r.events, 2);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0], 'http://replay.test:8080/m3-emv-trn/exm/locations');

    const slots = await pool.query('SELECT sec_key, quota, signup_available FROM slot ORDER BY sec_key');
    assert.deepEqual(slots.rows, [
      { sec_key: '1:1', quota: -1, signup_available: false },
      { sec_key: '2:2', quota: 3, signup_available: true },
    ]);
    const ev = await pool.query('SELECT kind, task_id, run_id FROM slot_event');
    assert.equal(ev.rowCount, 2);
    assert.ok(ev.rows.every((e) => e.kind === 'new' && e.task_id === t.taskId));

    const log = await pool.query('SELECT rows_seen, empty_streak, last_ok::float8 AS last_ok FROM scan_log');
    assert.equal(log.rows[0].rows_seen, 2);
    assert.equal(log.rows[0].empty_streak, 0);

    const tl = await pool.query('SELECT outcome, worker_id, az, finished_at FROM scan_task_log WHERE task_id = $1', [t.taskId]);
    assert.equal(tl.rows[0].outcome, 'ok');
    assert.equal(tl.rows[0].worker_id, 'i-test');
    assert.equal(tl.rows[0].az, 'us-east-1a');
    assert.ok(tl.rows[0].finished_at);

    const raw = puts.find((p) => p.key.startsWith('raw/'));
    assert.match(raw!.key, /^raw\/dt=\d{4}-\d{2}-\d{2}\/license=3\/dmv=63\/\d+\.html\.gz$/);
    const events = puts.find((p) => p.key.startsWith('events/'));
    assert.match(events!.key, new RegExp(`^events/dt=\\d{4}-\\d{2}-\\d{2}/${t.taskId}\\.jsonl$`));
    const lines = String(events!.body).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].taskId, t.taskId);
    assert.equal(published.length, 0, 'new 不推 SNS');

    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].Tier, 'hot');
    assert.equal(metrics[0].Target, 'replay');
    assert.equal(metrics[0].ScanErrors, 0);
    assert.equal(metrics[0].ScanDurationMs, 25);
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
    const t2 = task({ runId: 'run-42' });
    const r = await run(t2);
    assert.equal(r.events, 1);
    assert.equal(r.released, 1);
    assert.equal(published.length, 1);
    assert.equal(published[0].kind, 'released');
    assert.equal(published[0].target, 'replay');
    assert.equal(published[0].oldQuota, -1);
    assert.equal(published[0].newQuota, 2);
    assert.equal(published[0].runId, 'run-42');
    assert.equal(published[0].taskId, t2.taskId);

    const rel = await pool.query("SELECT run_id, task_id FROM slot_event WHERE kind = 'released'");
    assert.equal(rel.rows[0].run_id, 'run-42');
    const unchanged = await pool.query("SELECT updated_at::float8 AS u, first_seen::float8 AS f FROM slot WHERE sec_key = '2:2'");
    assert.ok(unchanged.rows[0].u < clock, '沒變動的列不更新');
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
    const kinds = await pool.query("SELECT kind, sec_key, exam_date::text AS d FROM slot_event WHERE kind <> 'new' ORDER BY kind");
    assert.deepEqual(
      kinds.rows.map((r) => r.kind),
      ['decreased', 'filled', 'gone'],
    );
    const left = await pool.query('SELECT count(*)::int AS n FROM slot');
    assert.equal(left.rows[0].n, 2);
  });

  test('冪等：同一個 taskId 重送，已完成就直接刪訊息、不再抓', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 1 }]);
    const t = task();
    await run(t);
    assert.equal(fetchCalls.length, 1);
    const again = await run(t, deps(), 2);
    assert.deepEqual([again.outcome, again.deleteMessage], ['duplicate', true]);
    assert.equal(fetchCalls.length, 1);
    const ev = await pool.query('SELECT count(*)::int AS n FROM slot_event');
    assert.equal(ev.rows[0].n, 1, '事件不會重複寫');
  });

  test('冪等：另一台還在處理（租約未過期）時不重做、也不刪訊息；租約過期後可接手', async () => {
    const t = task();
    await pool.query(
      `INSERT INTO scan_task_log (task_id, license_type, dmv_no, tier, target, enqueued_at, started_at, worker_id)
       VALUES ($1, '3', '63', 'hot', 'replay', $2, $3, 'i-other')`,
      [t.taskId, t.enqueuedAt, clock - 5_000],
    );
    const r = await run(t);
    assert.deepEqual([r.outcome, r.deleteMessage], ['in_progress', false]);
    assert.equal(fetchCalls.length, 0);

    clock += CLAIM_LEASE_MS + 1;
    const r2 = await run(t, deps(), 2);
    assert.equal(r2.outcome, 'ok');
    const tl = await pool.query('SELECT worker_id, receive_count FROM scan_task_log WHERE task_id = $1', [t.taskId]);
    assert.equal(tl.rows[0].worker_id, 'i-test');
    assert.equal(tl.rows[0].receive_count, 2);
  });

  test('降頻：長期沒場次的組合 24 小時內跳過、不發請求；實驗任務（有 runId）不跳過', async () => {
    await pool.query(
      `INSERT INTO scan_log (license_type, dmv_no, last_ok, rows_seen, empty_streak) VALUES ('3', '63', $1, 0, $2)`,
      [clock - 3600_000, PRUNE_AFTER_EMPTY],
    );
    const t = task();
    const r = await run(t);
    assert.deepEqual([r.outcome, r.deleteMessage], ['skipped', true]);
    assert.equal(fetchCalls.length, 0);
    const tl = await pool.query('SELECT outcome, finished_at FROM scan_task_log WHERE task_id = $1', [t.taskId]);
    assert.equal(tl.rows[0].outcome, 'skipped');
    assert.ok(tl.rows[0].finished_at);

    const exp = await run(task({ runId: 'e1' }));
    assert.equal(exp.outcome, 'ok');
    assert.equal(fetchCalls.length, 1);
  });

  test('降頻：超過 24 小時就複查；連續空結果會累加 empty_streak', async () => {
    await pool.query(
      `INSERT INTO scan_log (license_type, dmv_no, last_ok, rows_seen, empty_streak) VALUES ('3', '63', $1, 0, $2)`,
      [clock - 25 * 3600_000, PRUNE_AFTER_EMPTY],
    );
    const r = await run(task());
    assert.equal(r.outcome, 'ok');
    const log = await pool.query('SELECT empty_streak FROM scan_log');
    assert.equal(log.rows[0].empty_streak, PRUNE_AFTER_EMPTY + 1);
  });

  test('上游錯誤：記 scan_log 錯誤與 outcome=error，照樣刪訊息（不讓 SQS 立刻重打）', async () => {
    status = 502;
    html = 'Bad Gateway';
    const t = task();
    const r = await run(t);
    assert.deepEqual([r.outcome, r.deleteMessage], ['error', true]);
    const log = await pool.query('SELECT last_error, last_ok, empty_streak FROM scan_log');
    assert.equal(log.rows[0].last_error, 'HTTP 502');
    assert.equal(log.rows[0].last_ok, null);
    assert.equal(log.rows[0].empty_streak, 0, '錯誤不能算成空結果，否則會誤觸降頻');
    const tl = await pool.query('SELECT outcome, error FROM scan_task_log WHERE task_id = $1', [t.taskId]);
    assert.deepEqual(tl.rows[0], { outcome: 'error', error: 'HTTP 502' });
    assert.equal(metrics.at(-1)!.ScanErrors, 1);
  });

  test('上游錯誤：頁面結構不對（解析失敗）也算 error', async () => {
    html = '<html>維護中</html>';
    const r = await run(task());
    assert.equal(r.outcome, 'error');
    assert.match(r.error!, /trnTable/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM slot')).rows[0].n, 0);
  });

  test('replay 不打官網：MVDIS_BASE_URL 指向官網時一個請求都不發，任務記成 error', async () => {
    for (const baseUrl of ['https://www.mvdis.gov.tw', 'https://WWW.MVDIS.GOV.TW/', undefined]) {
      const t = task({ target: 'replay' });
      const r = await run(t, deps({ baseUrl }));
      assert.equal(r.outcome, 'error', String(baseUrl));
      assert.equal(r.deleteMessage, true);
    }
    assert.equal(fetchCalls.length, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM scan_log')).rows[0].n, 0, '不污染上游健康度');
  });

  test('並發：同一組合兩個任務同時處理，只會記一次 new 事件', async () => {
    setPage([
      { date: D1, session: '上午', group: 1, quota: 1 },
      { date: D2, session: '上午', group: 1, quota: 2 },
    ]);
    const results = await Promise.all([run(task()), run(task()), run(task())]);
    assert.ok(results.every((r) => r.outcome === 'ok'));
    const ev = await pool.query("SELECT count(*)::int AS n FROM slot_event WHERE kind = 'new'");
    assert.equal(ev.rows[0].n, 2);
  });

  test('舊快照不能蓋掉新資料：晚抓的先提交時，早抓的結果不套用', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 9 }]);
    await run(task());
    // 讓下一次抓取的時間點早於已寫入的 last_ok
    clock -= 10_000;
    setPage([{ date: D1, session: '上午', group: 1, quota: 'full' }]);
    const t = task();
    const r = await run(t);
    assert.equal(r.outcome, 'ok');
    assert.equal(r.events, 0);
    const q = await pool.query('SELECT quota FROM slot');
    assert.equal(q.rows[0].quota, 9);
    const tl = await pool.query('SELECT error FROM scan_task_log WHERE task_id = $1', [t.taskId]);
    assert.match(tl.rows[0].error, /stale/);
  });

  test('交易提交後 S3／SNS 失敗：資料已寫入、訊息照樣刪，錯誤有記 log', async () => {
    setPage([{ date: D1, session: '上午', group: 1, quota: 'full' }]);
    await run(task());
    clock += 60_000;
    setPage([{ date: D1, session: '上午', group: 1, quota: 1 }]);
    const logs: Array<Record<string, unknown>> = [];
    const r = await run(
      task(),
      deps({
        putObject: async () => {
          throw new Error('s3 down');
        },
        publishReleased: async () => {
          throw new Error('sns down');
        },
        log: (o) => logs.push(o),
      }),
    );
    assert.deepEqual([r.outcome, r.deleteMessage, r.released], ['ok', true, 1]);
    assert.ok(logs.some((l) => l.msg === 'post-commit side effect failed'));
  });

  test('格式錯誤的訊息不刪，讓它進 DLQ', async () => {
    const r = await processMessage('{"v":1}', 1, deps());
    assert.deepEqual([r.outcome, r.deleteMessage], ['invalid', false]);
  });

  test('資料庫錯誤會丟例外（呼叫端不刪訊息，讓 SQS 重送）', async () => {
    const broken = { query: async () => { throw new Error('db down'); } } as unknown as pg.Pool;
    await assert.rejects(run(task(), deps({ pool: broken })), /db down/);
  });
});
