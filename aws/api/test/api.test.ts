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
import { createHandler, todayIso } from '../src/app.ts';
import { createPool, poolConfigFromEnv } from '../src/db.ts';

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
      // at 全部不同（間隔約 3.1 小時，最早約 41 天前），涵蓋「30 天內／外」兩種
      at: NOW - k * 11_160_000 - 7_000,
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
  // 原型的 last_tick 存在 scan_state；AWS 版從 scan_task_log 推導，兩邊應該得到同一個值
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

  test('每站頁面：Host 標頭只接受主機名稱，其餘退回 localhost；PUBLIC_ORIGIN 優先', async () => {
    const { request } = await import('node:http');
    const get = (host: string) =>
      new Promise<string>((resolve, reject) => {
        const u = new URL(base);
        request({ host: u.hostname, port: u.port, path: '/station/41', headers: { Host: host } }, (res) => {
          let s = '';
          res.on('data', (c) => (s += c));
          res.on('end', () => resolve(s));
        }).on('error', reject).end();
      });
    assert.match(await get('mvdis.example.org'), /<link rel="canonical" href="http:\/\/mvdis\.example\.org\/station\/41" \/>/);
    const evil = await get('x"><script>alert(1)</script>');
    assert.ok(!evil.includes('<script>alert(1)'));
    assert.match(evil, /href="http:\/\/localhost\/station\/41"/);

    const s = createServer(createHandler({ getDb: async () => pool, publicOrigin: 'https://watch.example.org/' }));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const html = await (await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/station/41`)).text();
    await new Promise((r) => s.close(r));
    assert.match(html, /href="https:\/\/watch\.example\.org\/station\/41"/);
  });
});

describe('連線設定', () => {
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
