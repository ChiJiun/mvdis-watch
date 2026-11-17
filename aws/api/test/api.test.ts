/**
 * api 服務的整合測試。
 *
 * 「格式和原型一致」用最直接的方式驗證：同一份測試資料同時灌進
 *   - 原型的 SQLite schema（根目錄 schema.sql，用 node:sqlite 模擬 D1），由**原型自己的 src/index.ts** 回應；
 *   - AWS 版的 Postgres schema（aws/db/schema.pg.sql），由這個服務回應；
 * 再逐一比對狀態碼、快取標頭與 JSON 內容。只有跟「現在時間」有關的頂層欄位（at、serverTime）會先拿掉。
 *
 * 需要一個 Postgres：預設連 postgres://mvdis:mvdis@localhost:5432/mvdis（aws/docker-compose.yml），
 * 可用 TEST_DATABASE_URL 覆寫。測試會自己建一個獨立的資料庫 mvdis_api_test，不會動到其他開發線的資料。
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { createHandler, createHealthCheck, todayIso } from '../src/app.ts';
import { createPool, createPools, healthPoolConfig, poolConfigFromEnv } from '../src/db.ts';

const ROOT = new URL('../../../', import.meta.url);
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://mvdis:mvdis@localhost:5432/mvdis';
const TEST_DB = 'mvdis_api_test';
const testUrl = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
})();

const DAY = 86400_000;
const NOW = Date.now();
const dateAt = (offsetDays: number) => todayIso(NOW + offsetDays * DAY);

/* ---------- 測試資料：決定性的偽亂數，兩邊灌一模一樣的內容 ---------- */

let seed = 20261116;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

type Slot = {
  license_type: string; dmv_no: string; exam_date: string; sec_key: string; quota: number;
  signup_available: boolean; sec_desc: string | null; session: string | null; grp: number | null;
  weekday: string | null; is_weekend: boolean; first_seen: number; updated_at: number; seen_at: number;
};
type Ev = {
  license_type: string; dmv_no: string; exam_date: string; sec_key: string; kind: string;
  old_quota: number | null; new_quota: number | null; at: number; task_id: string | null; run_id: string | null;
};

function buildFixture() {
  const slots: Slot[] = [];
  const stations = ['21', '40', '41', '63'];
  const licenses = ['3', 'A', '5'];
  // 'M:1' 與 'h:zz' 在 C 排序（位元組序，和 SQLite 相同）與 en_US 排序下先後相反，用來抓排序規則差異
  const secKeys = ['M:1', 'h:zz', 'A:2', '12:3'];
  const offsets = [-3, 0, 1, 2, 5, 6, 10, 40];
  const wd = ['日', '一', '二', '三', '四', '五', '六'];
  let uniqueQuota = 1; // 有位的場次 quota 全部不同，排序就不會有同分、兩邊順序可以逐列比
  for (const dmv of stations)
    for (const lt of licenses)
      for (const off of offsets)
        for (const sk of secKeys) {
          if (rand() < 0.35) continue;
          const r = rand();
          const quota = r < 0.3 ? -1 : r < 0.38 ? 0 : uniqueQuota++;
          const date = dateAt(off);
          const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
          const t = NOW - Math.floor(rand() * 20 * DAY);
          slots.push({
            license_type: lt, dmv_no: dmv, exam_date: date, sec_key: sk, quota,
            signup_available: quota > 0 && rand() < 0.8,
            sec_desc: rand() < 0.1 ? null : `上午場次 組別${sk.length} 「測試 & <轉義>」`,
            session: rand() < 0.1 ? null : pick(['上午', '下午', '']),
            grp: rand() < 0.2 ? null : Math.floor(rand() * 5),
            weekday: wd[dow], is_weekend: dow === 0 || dow === 6,
            first_seen: t - DAY, updated_at: t, seen_at: t + 1000,
          });
        }

  const events: Ev[] = [];
  const kinds = ['released', 'filled', 'released', 'increased', 'decreased', 'new', 'gone', 'filled'];
  for (let k = 0; k < 320; k++) {
    const kind = pick(kinds);
    events.push({
      license_type: pick(licenses), dmv_no: pick(stations), exam_date: dateAt(pick([1, 2, 5])),
      sec_key: pick(['M:1', 'h:zz']), kind,
      old_quota: kind === 'new' ? null : pick([-1, 3, 7]),
      new_quota: kind === 'gone' ? null : pick([-1, 2, 9]),
      // 每 3 筆共用一個 at，模擬 worker 同一輪寫入的事件（正式資料就是這樣），用來比對同分時的順序；
      // 每輪間隔約 9.3 小時，最早約 41 天前，涵蓋「30 天內／外」兩種
      at: NOW - Math.floor(k / 3) * 33_480_000 - 7_000,
      task_id: rand() < 0.5 ? crypto.randomUUID() : null,
      run_id: rand() < 0.2 ? 'exp-1' : null,
    });
  }

  const scanLog = [
    { license_type: '3', dmv_no: '41', last_ok: NOW - 60_000, last_error: null, last_error_at: null, rows_seen: 12, empty_streak: 0, duration_ms: 812 },
    { license_type: 'A', dmv_no: '41', last_ok: NOW - 600_000, last_error: 'timeout', last_error_at: NOW - 30_000, rows_seen: 4, empty_streak: 0, duration_ms: 15000 },
    { license_type: 'G', dmv_no: '41', last_ok: NOW - 9 * DAY, last_error: null, last_error_at: null, rows_seen: 0, empty_streak: 9, duration_ms: 400 },
    { license_type: '3', dmv_no: '63', last_ok: null, last_error: 'HTTP 503', last_error_at: NOW - 5_000, rows_seen: 0, empty_streak: 0, duration_ms: null },
    { license_type: '5', dmv_no: '21', last_ok: NOW - 120_000, last_error: null, last_error_at: null, rows_seen: 3, empty_streak: 5, duration_ms: 950 },
  ];

  // AWS 版的 lastTick = scan_log 的 last_ok／last_error_at 最大值，這裡是 63 站那筆失敗的時間
  const lastTick = NOW - 5_000;
  // scan_task_log 不參與任何 API 回應；放一筆比 lastTick 更新的任務，確認沒有被拿去算
  const tasks = [{ run_id: null, finished_at: NOW - 1_000 }];
  return { slots, events, scanLog, tasks, lastTick };
}

/* ---------- 兩邊的資料庫 ---------- */

async function resetPg(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const c = new pg.Client({ connectionString: testUrl });
  await c.connect();
  await c.query(readFileSync(new URL('aws/db/schema.pg.sql', ROOT), 'utf8'));
  await c.end();
}

async function seedPg(pool: pg.Pool, fx: ReturnType<typeof buildFixture>) {
  await pool.query('TRUNCATE slot, slot_event, scan_log, scan_task_log RESTART IDENTITY');
  for (const s of fx.slots) {
    await pool.query(
      `INSERT INTO slot VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [s.license_type, s.dmv_no, s.exam_date, s.sec_key, s.quota, s.signup_available, s.sec_desc, s.session,
        s.grp, s.weekday, s.is_weekend, s.first_seen, s.updated_at, s.seen_at],
    );
  }
  for (const e of fx.events) {
    await pool.query(
      `INSERT INTO slot_event (license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at, task_id, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.license_type, e.dmv_no, e.exam_date, e.sec_key, e.kind, e.old_quota, e.new_quota, e.at, e.task_id, e.run_id],
    );
  }
  for (const l of fx.scanLog) {
    await pool.query(`INSERT INTO scan_log VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [l.license_type, l.dmv_no, l.last_ok, l.last_error, l.last_error_at, l.rows_seen, l.empty_streak, l.duration_ms]);
  }
  for (const t of fx.tasks) {
    await pool.query(
      `INSERT INTO scan_task_log (task_id, run_id, license_type, dmv_no, tier, target, enqueued_at, started_at, finished_at, outcome)
       VALUES ($1,$2,'3','41','hot','live',$3,$3,$4,$5)`,
      [crypto.randomUUID(), t.run_id, NOW - 7_200_000, t.finished_at, t.finished_at ? 'ok' : null],
    );
  }
}

function makeSqlite() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('schema.sql', ROOT), 'utf8'));
  return db;
}

function seedSqlite(db: DatabaseSync, fx: ReturnType<typeof buildFixture>) {
  const b = (v: boolean) => (v ? 1 : 0);
  const ins = db.prepare('INSERT INTO slot VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const s of fx.slots) {
    ins.run(s.license_type, s.dmv_no, s.exam_date, s.sec_key, s.quota, b(s.signup_available), s.sec_desc, s.session,
      s.grp, s.weekday, b(s.is_weekend), s.first_seen, s.updated_at, s.seen_at);
  }
  const ev = db.prepare(
    'INSERT INTO slot_event (license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at) VALUES (?,?,?,?,?,?,?,?)');
  for (const e of fx.events) ev.run(e.license_type, e.dmv_no, e.exam_date, e.sec_key, e.kind, e.old_quota, e.new_quota, e.at);
  const sl = db.prepare('INSERT INTO scan_log VALUES (?,?,?,?,?,?,?,?)');
  for (const l of fx.scanLog) sl.run(l.license_type, l.dmv_no, l.last_ok, l.last_error, l.last_error_at, l.rows_seen, l.empty_streak, l.duration_ms);
  // 原型的 last_tick 存在 scan_state；AWS 版從 scan_log 推導，兩邊應該得到同一個值
  db.prepare('INSERT INTO scan_state (key, value) VALUES (?, ?)').run('last_tick', String(fx.lastTick));
}

/** node:sqlite 包成原型用到的 D1 介面子集 */
function d1(db: DatabaseSync) {
  const stmt = (sql: string, binds: unknown[] = []): any => ({
    bind: (...b: unknown[]) => stmt(sql, b),
    all: async () => ({ results: db.prepare(sql).all(...(binds as any[])) }),
    first: async () => db.prepare(sql).get(...(binds as any[])) ?? null,
    run: async () => db.prepare(sql).run(...(binds as any[])),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => Promise.all(ss.map((s) => s.run())) };
}

/* ---------- 兩邊的伺服器 ---------- */

const PROTO_ORIGIN = 'http://proto.test';
let proto: { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> };
let protoEnv: { DB: unknown; ASSETS: { fetch: (r: Request) => Promise<Response> } };
let sqlite: DatabaseSync;
let pool: pg.Pool;
let server: Server;
let base: string;
let fx: ReturnType<typeof buildFixture>;

type Got = { status: number; headers: Headers; text: string };

async function askProto(path: string): Promise<Got> {
  const res = await proto.fetch(new Request(PROTO_ORIGIN + path), protoEnv, { waitUntil() {} });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function askApi(path: string, init?: RequestInit): Promise<Got> {
  const res = await fetch(base + path, init);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** 拿掉跟呼叫當下時間有關的頂層欄位；scanLog 原型沒排序，兩邊都先排好 */
function normalize(body: any) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { at: _at, serverTime: _st, ...rest } = body;
    if (Array.isArray(rest.scanLog)) {
      rest.scanLog = [...rest.scanLog].sort((a: any, b: any) => (a.license_type < b.license_type ? -1 : 1));
    }
    return rest;
  }
  return body;
}

async function assertSameAsProto(path: string) {
  const [a, b] = await Promise.all([askProto(path), askApi(path)]);
  assert.equal(b.status, a.status, `${path} 狀態碼`);
  for (const h of ['content-type', 'cache-control', 'access-control-allow-origin']) {
    assert.equal(b.headers.get(h), a.headers.get(h), `${path} 標頭 ${h}`);
  }
  if ((a.headers.get('content-type') ?? '').includes('json')) {
    const pa = JSON.parse(a.text);
    const pb = JSON.parse(b.text);
    assert.deepStrictEqual(normalize(pb), normalize(JSON.parse(JSON.stringify(pa))), `${path} 內容`);
    return pb;
  }
  assert.equal(b.text.replaceAll(base, 'ORIGIN'), a.text.replaceAll(PROTO_ORIGIN, 'ORIGIN'), `${path} 內容`);
  return b.text;
}

before(async () => {
  // 原型的 fetch() 會碰 Cloudflare 的 Cache API；測試中讓它永遠 miss
  (globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } };
  proto = (await import('../../../src/index.ts')).default as any;

  await resetPg();
  pool = await createPool({ DATABASE_URL: testUrl, DB_POOL_MAX: '5' });
  sqlite = makeSqlite();
  const stationHtml = readFileSync(new URL('public/station.html', ROOT), 'utf8');
  protoEnv = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response(stationHtml) } };

  server = createServer(createHandler({ getDb: async () => pool }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  sqlite.close();
});

describe('空資料庫時和原型一致', () => {
  for (const path of ['/api/meta', '/api/available', '/api/overview', '/api/events', '/api/slots?licenseType=3&dmvNo=41', '/api/station?dmvNo=41']) {
    test(path, async () => {
      await assertSameAsProto(path);
    });
  }
});

describe('有資料時和原型一致', () => {
  before(async () => {
    fx = buildFixture();
    await seedPg(pool, fx);
    seedSqlite(sqlite, fx);
  });

  const paths = () => [
    '/api',
    '/api/meta',
    '/api/available',
    '/api/available?licenseType=3',
    '/api/available?dmvNo=41&weekendOnly=1',
    `/api/available?county=${encodeURIComponent('新北市')}`,
    '/api/available?lv1=40&minQuota=5',
    '/api/available?from=&limit=5',
    `/api/available?from=${dateAt(1)}&to=${dateAt(6)}`,
    '/api/available?limit=2000',
    '/api/available?limit=0',
    '/api/available?minQuota=-4&licenseType=A',
    '/api/available?minQuota=99999999999',
    '/api/available?minQuota=2.5',
    '/api/available?limit=1e400',
    '/api/available?limit=-1e400',
    '/api/events?limit=1e400',
    '/api/events?limit=7',
    '/api/events?kind=filled&limit=4',
    '/api/overview',
    '/api/events',
    '/api/events?kind=released&limit=10',
    '/api/events?limit=600',
    '/api/events?kind=nope',
    '/api/slots?licenseType=3&dmvNo=41',
    '/api/slots?licenseType=A&dmvNo=63',
    '/api/slots?licenseType=3',
    '/api/slots?licenseType=Z&dmvNo=41',
    '/api/station?dmvNo=41',
    '/api/station?dmvNo=63',
    '/api/station?dmvNo=21',
    '/api/station?dmvNo=99',
    '/api/station',
    '/api/nope',
    '/api/',
    '/station/41',
    '/station/41/',
    '/station/99',
    '/robots.txt',
    '/sitemap.xml',
  ];

  // test() 要在 describe 註冊時就決定，但 dateAt 只依賴 NOW，所以可以先算路徑
  for (const path of paths()) {
    test(path, async () => {
      await assertSameAsProto(path);
    });
  }

  test('測試資料真的有涵蓋到要比的情況', async () => {
    const meta = JSON.parse((await askApi('/api/meta')).text);
    assert.equal(meta.lastTick, fx.lastTick, 'lastTick 取 scan_log 最近一次掃描（成功或失敗）的時間');
    assert.ok(meta.health.combos > 0 && meta.health.pruned > 0 && meta.health.failing > 0);

    const avail = JSON.parse((await askApi('/api/available?from=')).text).rows;
    assert.ok(avail.length > 30);
    assert.ok(avail.some((r: any) => r.exam_date < todayIso(NOW)), '有過去日期');
    assert.ok(avail.some((r: any) => r.is_weekend === 1) && avail.some((r: any) => r.is_weekend === 0));
    const row = avail[0];
    assert.match(row.exam_date, /^\d{4}-\d{2}-\d{2}$/, 'DATE 轉回 YYYY-MM-DD 字串');
    assert.ok([0, 1].includes(row.signup_available), 'BOOLEAN 轉回 0／1');
    assert.equal(typeof row.first_seen, 'number', 'BIGINT 轉回 number');

    const ev = JSON.parse((await askApi('/api/events')).text).rows;
    assert.ok(ev.some((e: any, i: number) => i > 0 && e.at === ev[i - 1].at), '事件有同一個 at 的情況，排序同分時的順序有被比到');

    const st = JSON.parse((await askApi('/api/station?dmvNo=41')).text);
    assert.ok(st.slots.some((r: any) => r.quota === -1), '每站頁面含額滿場次');
    assert.ok(st.stats.some((s: any) => s.fillSamples > 0), '有釋位→額滿的配對樣本');
    assert.ok(st.events.every((e: any) => !('task_id' in e) && !('run_id' in e)), 'AWS 版新增欄位不外漏');
    const keys = st.slots.filter((r: any) => r.license_type === st.slots[0].license_type && r.exam_date === st.slots[0].exam_date).map((r: any) => r.sec_key);
    assert.deepEqual(keys, [...keys].sort(), 'sec_key 依位元組序排序');
  });
});

describe('AWS 版自己的行為', () => {
  test('GET /healthz：DB 連得到回 200', async () => {
    const r = await askApi('/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(JSON.parse(r.text), { ok: true });
  });

  test('GET /healthz：DB 連不到回 503，API 回 500 且不外漏錯誤細節', async () => {
    const bad = await createPool({ DATABASE_URL: 'postgres://mvdis:wrong@127.0.0.1:1/none' });
    const s = createServer(createHandler({ getDb: async () => bad }));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const h = await fetch(`${url}/healthz`);
      assert.equal(h.status, 503);
      const m = await fetch(`${url}/api/meta`);
      assert.equal(m.status, 500);
      assert.deepEqual(await m.json(), { error: 'internal error' });
      // 連線池還沒建起來（例如 Secrets Manager 讀不到）也一樣是 503
      const s2 = createServer(createHandler({ getDb: () => Promise.reject(new Error('no secret')) }));
      await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
      const h2 = await fetch(`http://127.0.0.1:${(s2.address() as AddressInfo).port}/healthz`);
      assert.equal(h2.status, 503);
      await new Promise((r) => s2.close(r));
    } finally {
      await new Promise((r) => s.close(r));
      await bad.end();
    }
  });

  test('日期參數格式錯誤回 400（Postgres 的 DATE 不能拿任意字串比較）', async () => {
    for (const q of ['from=2026-13-01', 'to=abc', 'from=2026-02-30', "to=2026-01-01'"]) {
      const r = await askApi(`/api/available?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
      assert.match(JSON.parse(r.text).error, /YYYY-MM-DD/);
    }
  });

  test('數字參數不是數字時退回預設值，不會變成 500', async () => {
    const a = await askApi('/api/available?limit=abc&minQuota=xyz');
    assert.equal(a.status, 200);
    const d = await askApi('/api/available');
    assert.deepEqual(JSON.parse(a.text).rows, JSON.parse(d.text).rows);
    const e = await askApi('/api/events?limit=NaN');
    assert.equal(JSON.parse(e.text).rows.length, 80);
  });

  test('HEAD 只回標頭；OPTIONS 回 CORS；不移植的端點回 404', async () => {
    const h = await askApi('/api/meta', { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal(h.text, '');
    assert.equal(h.headers.get('cache-control'), 'public, max-age=30');
    assert.ok(Number(h.headers.get('content-length')) > 100);

    const o = await askApi('/api/meta', { method: 'OPTIONS' });
    assert.equal(o.status, 204);
    assert.equal(o.headers.get('access-control-allow-origin'), '*');

    for (const [path, method] of [['/api/subscriptions', 'GET'], ['/api/scan', 'POST'], ['/api/meta', 'POST']]) {
      const r = await askApi(path, { method });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
    assert.equal((await askApi('/', { method: 'POST' })).status, 405);
    assert.equal((await askApi('/nope')).status, 404);
  });

  test('儀表板靜態檔：內容和 public/ 相同、帶快取標頭與 ETag', async () => {
    const files: Array<[string, string, string]> = [
      ['/', 'index.html', 'text/html'],
      ['/index.html', 'index.html', 'text/html'],
      ['/app.js', 'app.js', 'text/javascript'],
      ['/station.js', 'station.js', 'text/javascript'],
      ['/style.css', 'style.css', 'text/css'],
      ['/station.html', 'station.html', 'text/html'],
      ['/aura.js', 'aura.js', 'text/javascript'],
    ];
    for (const [path, file, type] of files) {
      const r = await askApi(path);
      assert.equal(r.status, 200, path);
      assert.equal(r.text, readFileSync(new URL(`public/${file}`, ROOT), 'utf8'), path);
      assert.ok(r.headers.get('content-type')!.startsWith(type), path);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
      const etag = r.headers.get('etag')!;
      const again = await askApi(path, { headers: { 'If-None-Match': etag } });
      assert.equal(again.status, 304, path);
    }
  });

  test('同源托管的 shaders 套件與授權檔：內容和 public/vendor/ 相同、長期快取', async () => {
    const files: Array<[string, string]> = [
      ['vendor/shaders-4.0.7.js', 'text/javascript'],
      ['vendor/shaders-4.0.7.LICENSE.txt', 'text/plain'],
    ];
    for (const [file, type] of files) {
      const r = await askApi(`/${file}`);
      assert.equal(r.status, 200, file);
      assert.equal(r.text, readFileSync(new URL(`public/${file}`, ROOT), 'utf8'), file);
      assert.ok(r.headers.get('content-type')!.startsWith(type), file);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000', file);
    }
    // 白名單只開放這兩個檔案，vendor/ 底下其他路徑都是 404
    assert.equal((await askApi('/vendor/')).status, 404);
    assert.equal((await askApi('/vendor/shaders-4.0.7.js.map')).status, 404);
    assert.equal((await askApi('/vendor/shaders.js')).status, 404);
  });

  test('每站頁面：Host 標頭只接受主機名稱，其餘退回 localhost；PUBLIC_ORIGIN 優先', async () => {
    const { request } = await import('node:http');
    const get = (host: string, extra: Record<string, string> = {}, path = '/station/41') =>
      new Promise<string>((resolve, reject) => {
        const u = new URL(base);
        request({ host: u.hostname, port: u.port, path, headers: { Host: host, ...extra } }, (res) => {
          let s = '';
          res.on('data', (c) => (s += c));
          res.on('end', () => resolve(s));
        }).on('error', reject).end();
      });
    assert.match(await get('mvdis.example.org'), /<link rel="canonical" href="http:\/\/mvdis\.example\.org\/station\/41" \/>/);
    const evil = await get('x"><script>alert(1)</script>');
    assert.ok(!evil.includes('<script>alert(1)'));
    assert.match(evil, /href="http:\/\/localhost\/station\/41"/);

    // X-Forwarded-Host 不在 CloudFront 的快取鍵裡，不能信任；X-Forwarded-Proto 只決定 http／https
    const fwd = { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' };
    const page = await get('mvdis.example.org', fwd);
    assert.ok(!page.includes('evil.example'));
    assert.match(page, /href="https:\/\/mvdis\.example\.org\/station\/41"/);
    const map = await get('mvdis.example.org', fwd, '/sitemap.xml');
    assert.ok(!map.includes('evil.example') && map.includes('https://mvdis.example.org/station/41'));

    const s = createServer(createHandler({ getDb: async () => pool, publicOrigin: 'https://watch.example.org/' }));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const html = await (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/station/41`)).text();
    await new Promise((r) => s.close(r));
    assert.match(html, /href="https:\/\/watch\.example\.org\/station\/41"/);
  });
});

describe('第 2 輪 review 的修正', () => {
  const listen = async (handler: ReturnType<typeof createHandler>) => {
    const s = createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  };

  test('B1：API 連線池被占滿時，/healthz 走獨立連線仍在 2 秒內回 200', async () => {
    const { api, health } = await createPools({ DATABASE_URL: testUrl, DB_POOL_MAX: '1', DB_CONNECT_TIMEOUT_MS: '3000' });
    const held = await api.connect(); // 把 API 連線池唯一的連線占住，模擬壓測時排隊
    const { s, url } = await listen(createHandler({ getDb: async () => api, healthCheck: createHealthCheck(async () => health, 2000) }));
    try {
      const pending = fetch(`${url}/api/meta`); // 會排隊等連線，3 秒後逾時
      const t0 = Date.now();
      const h = await fetch(`${url}/healthz`);
      assert.equal(h.status, 200);
      assert.ok(Date.now() - t0 < 2000, `healthz 花了 ${Date.now() - t0} ms`);
      assert.equal((await pending).status, 500, 'API 排隊超過 DB_CONNECT_TIMEOUT_MS 才回 500');
    } finally {
      held.release();
      await new Promise((r) => s.close(r));
      await Promise.all([api.end(), health.end()]);
    }
  });

  test('健康檢查：成功結果快取、同時進來的檢查共用一次查詢、失敗不快取', async () => {
    let calls = 0;
    let fail = false;
    let t = 1000;
    const db = { query: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); if (fail) throw new Error('down'); return {} as any; } };
    const check = createHealthCheck(async () => db, 2000, () => t);
    await Promise.all([check(), check(), check()]);
    assert.equal(calls, 1, '同時三個檢查只查一次');
    await check();
    assert.equal(calls, 1, '2 秒內走快取');
    t += 2001;
    fail = true;
    await assert.rejects(check());
    await assert.rejects(check());
    assert.equal(calls, 3, '失敗不快取');
  });

  test('只讀 public schema：DB 的預設 search_path 被改成 replay 也不會讀到實驗資料', async () => {
    const admin = new pg.Client({ connectionString: testUrl });
    await admin.connect();
    try {
      await admin.query(`INSERT INTO replay.slot VALUES ('3','41',$1,'X:9',777,true,NULL,NULL,NULL,NULL,false,1,1,1)`, [dateAt(3)]);
      await admin.query(`INSERT INTO replay.slot_event (license_type,dmv_no,exam_date,sec_key,kind,old_quota,new_quota,at)
                         VALUES ('3','41',$1,'X:9','released',-1,777,$2)`, [dateAt(3), NOW + 60_000]);
      await admin.query(`INSERT INTO replay.scan_log VALUES ('3','41',$1,NULL,NULL,1,0,1)`, [NOW + 60_000]);
      await admin.query(`ALTER DATABASE ${TEST_DB} SET search_path = replay, public`);
      const p2 = await createPool({ DATABASE_URL: testUrl });
      const { s, url } = await listen(createHandler({ getDb: async () => p2 }));
      try {
        const avail = await (await fetch(`${url}/api/available?minQuota=777`)).json();
        assert.deepEqual(avail.rows, []);
        const ev = await (await fetch(`${url}/api/events?limit=1`)).json();
        assert.notEqual(ev.rows[0]?.sec_key, 'X:9');
        const meta = await (await fetch(`${url}/api/meta`)).json();
        assert.equal(meta.lastTick, fx.lastTick, 'lastTick 不被 replay.scan_log 推進');
      } finally {
        await new Promise((r) => s.close(r));
        await p2.end();
      }
    } finally {
      await admin.query(`ALTER DATABASE ${TEST_DB} RESET search_path`);
      await admin.query('TRUNCATE replay.slot, replay.slot_event, replay.scan_log');
      await admin.end();
    }
  });

  test('含 NUL 的文字參數照原型回空陣列，不是 500', async () => {
    for (const path of ['/api/slots?licenseType=%00&dmvNo=41', '/api/events?kind=%00', '/api/available?dmvNo=%00', '/api/available?licenseType=3%00']) {
      const r = await askApi(path);
      assert.equal(r.status, 200, path);
      assert.deepEqual(JSON.parse(r.text).rows, [], path);
    }
  });

  test('年份 0000 回 400；absolute-form 壞網址回 400', async () => {
    for (const q of ['from=0000-01-01', 'to=0000-12-31']) assert.equal((await askApi(`/api/available?${q}`)).status, 400, q);
    const { connect } = await import('node:net');
    const u = new URL(base);
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(Number(u.port), u.hostname, () => sock.end('GET http://[/api/meta HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let s = '';
      sock.on('data', (c) => (s += c));
      sock.on('end', () => resolve(s));
      sock.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
  });

  test('弱 ETag 與多值 If-None-Match 都回 304；204／304 不帶 Content-Length', async () => {
    const etag = (await askApi('/style.css')).headers.get('etag')!;
    for (const inm of [`W/${etag}`, `"nope", ${etag}`, '*']) {
      const r = await fetch(`${base}/style.css`, { headers: { 'If-None-Match': inm } });
      assert.equal(r.status, 304, inm);
      assert.equal(r.headers.get('content-length'), null);
    }
    const o = await fetch(`${base}/api/meta`, { method: 'OPTIONS' });
    assert.equal(o.status, 204);
    assert.equal(o.headers.get('content-length'), null);
  });
});

/**
 * 可以「無聲斷線」的 TCP proxy：stall() 之後，既有連線的資料全部默默丟掉（不送 RST／FIN），
 * 新連線接受但永遠不回應——模擬 RDS 切換時舊主機消失。resume() 之後新連線恢復正常，舊連線維持卡死。
 */
async function stallableProxy(targetHost: string, targetPort: number) {
  const { createServer: createTcp, connect } = await import('node:net');
  let stalled = false;
  const sockets = new Set<import('node:net').Socket>();
  const conns: Array<{ dead: boolean }> = [];
  const server = createTcp((client) => {
    sockets.add(client);
    client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
    if (stalled) return; // 接受連線，但什麼都不回
    const c = { dead: false };
    conns.push(c);
    const upstream = connect(targetPort, targetHost);
    sockets.add(upstream);
    upstream.on('error', () => {});
    client.on('data', (d) => { if (!c.dead) upstream.write(d); });
    upstream.on('data', (d) => { if (!c.dead) client.write(d); });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => { sockets.delete(upstream); if (!c.dead) client.destroy(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    stall() {
      stalled = true;
      for (const c of conns) c.dead = true;
    },
    resume() {
      stalled = false;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

describe('第 3 輪 review 的修正', () => {
  test('R3-B1：DB 無聲斷線時 healthz 在 3 秒內回 503，DB 恢復後幾秒內回到 200（API 也恢復）', async () => {
    const target = new URL(testUrl);
    const proxy = await stallableProxy(target.hostname, Number(target.port || 5432));
    const proxied = new URL(testUrl);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(proxy.port);
    const { api, health } = await createPools({ DATABASE_URL: proxied.toString(), DB_STATEMENT_TIMEOUT_MS: '1000', DB_CONNECT_TIMEOUT_MS: '2000' });
    const s = createServer(createHandler({ getDb: async () => api, healthCheck: createHealthCheck(async () => health, 0) }));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const timed = async (path: string) => {
      const t0 = Date.now();
      const r = await fetch(url + path, { signal: AbortSignal.timeout(10_000) });
      await r.arrayBuffer();
      return { status: r.status, ms: Date.now() - t0 };
    };
    try {
      assert.equal((await timed('/healthz')).status, 200);
      assert.equal((await timed('/api/meta')).status, 200);

      proxy.stall();
      for (let i = 0; i < 2; i++) {
        const h = await timed('/healthz');
        assert.equal(h.status, 503, `斷線中第 ${i + 1} 次`);
        assert.ok(h.ms < 3000, `斷線中 healthz 花了 ${h.ms} ms，應低於 ALB 的 5 秒逾時`);
      }
      assert.equal((await timed('/api/meta')).status, 500, 'API 的卡住查詢由 query_timeout 結束，不會一直掛著');

      proxy.resume();
      const t0 = Date.now();
      let h = await timed('/healthz');
      while (h.status !== 200 && Date.now() - t0 < 8000) h = await timed('/healthz');
      assert.equal(h.status, 200, 'DB 恢復後 healthz 要回到 200');
      assert.ok(Date.now() - t0 < 5000, `恢復花了 ${Date.now() - t0} ms`);

      let m = await timed('/api/meta');
      while (m.status !== 200 && Date.now() - t0 < 10_000) m = await timed('/api/meta');
      assert.equal(m.status, 200, 'DB 恢復後 API 也要恢復');
    } finally {
      await new Promise((r) => s.close(r));
      await proxy.close();
      await Promise.all([api.end(), health.end()]);
    }
  });

  test('API 與健康檢查連線池都有用戶端查詢逾時與 TCP keepalive', async () => {
    const c = await poolConfigFromEnv({ DATABASE_URL: 'x', DB_STATEMENT_TIMEOUT_MS: '4000' });
    assert.equal(c.query_timeout, 6000, 'API：statement_timeout + 2 秒');
    assert.equal(c.keepAlive, true);
    const h = healthPoolConfig(c);
    assert.ok(h.query_timeout! > 0 && h.query_timeout! <= 3000, 'healthz：≤ 3 秒，低於 ALB 的 5 秒逾時');
    assert.ok(h.statement_timeout! < h.query_timeout!);
  });
});

describe('連線設定', () => {
  test('每條連線固定 search_path=public 與 DateStyle=ISO；連線等待逾時可設定', async () => {
    const c = await poolConfigFromEnv({ DATABASE_URL: 'x', DB_CONNECT_TIMEOUT_MS: '1500' });
    assert.equal(c.options, '-c search_path=public -c DateStyle=ISO');
    assert.equal(c.connectionTimeoutMillis, 1500);
    assert.equal((await poolConfigFromEnv({ DATABASE_URL: 'x' })).connectionTimeoutMillis, 5000);
    const h = healthPoolConfig(c);
    assert.equal(h.max, 1);
    assert.equal(h.options, c.options);
    assert.ok((h.connectionTimeoutMillis ?? 0) <= 2000);
  });

  test('DATABASE_URL 優先；連線池大小與 SSL 可設定', async () => {
    const c = await poolConfigFromEnv({ DATABASE_URL: 'postgres://u:p@h/db', DB_HOST: 'ignored', DB_POOL_MAX: '25' });
    assert.equal(c.connectionString, 'postgres://u:p@h/db');
    assert.equal(c.max, 25);
    assert.equal(c.ssl, undefined);
    const s = await poolConfigFromEnv({ DATABASE_URL: 'postgres://u:p@h/db', DB_SSL: 'no-verify' });
    assert.deepEqual(s.ssl, { rejectUnauthorized: false });
    assert.equal((await poolConfigFromEnv({ DATABASE_URL: 'x' })).max, 10);
  });

  test('設定錯誤時講清楚缺什麼', async () => {
    await assert.rejects(poolConfigFromEnv({ DB_HOST: 'h' }), /DB_NAME、DB_SECRET_ARN/);
    await assert.rejects(poolConfigFromEnv({ DATABASE_URL: 'x', DB_POOL_MAX: '0' }), /DB_POOL_MAX/);
    await assert.rejects(poolConfigFromEnv({ DATABASE_URL: 'x', DB_SSL: 'yes' }), /DB_SSL/);
  });

  test('沒有 DATABASE_URL 時從 Secrets Manager 讀帳密（用假的 Secrets Manager 端點）', async () => {
    let seen: { target?: string; body?: any } = {};
    const fake = createServer((req, res) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => {
        seen = { target: req.headers['x-amz-target'] as string, body: JSON.parse(s) };
        res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.1' });
        res.end(JSON.stringify({ Name: 'db', SecretString: JSON.stringify({ username: 'mvdis', password: 's3cret' }) }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const saved = { ...process.env };
    Object.assign(process.env, {
      AWS_ENDPOINT_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1',
    });
    try {
      const c = await poolConfigFromEnv({ DB_HOST: 'db.internal', DB_NAME: 'mvdis', DB_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:db' });
      assert.equal(seen.target, 'secretsmanager.GetSecretValue');
      assert.equal(seen.body.SecretId, 'arn:aws:secretsmanager:us-east-1:1:secret:db');
      assert.equal(c.host, 'db.internal');
      assert.equal(c.port, 5432);
      assert.equal(c.database, 'mvdis');
      assert.equal(c.user, 'mvdis');
      assert.equal(c.password, 's3cret');
      assert.deepEqual(c.ssl, { rejectUnauthorized: false }, 'RDS 預設 force_ssl，AWS 路徑預設開 SSL');
    } finally {
      process.env = saved;
      await new Promise((r) => fake.close(r));
    }
  });
});
