/**
 * 公開 API 與儀表板頁的 HTTP 處理器，對應原型 src/index.ts 的 fetch()。
 *
 * 和原型的差異（刻意的）：
 *   - 原型在 Worker 裡用 Cache API 做 30 秒邊緣快取；AWS 版交給 CloudFront，
 *     這裡只負責帶 `Cache-Control: public, max-age=30`，自己不做行程內快取
 *     （E1 實驗要量的就是打到 ASG 的負載，行程內快取會讓 ASG 量不到壓力）。
 *   - 不移植 /api/subscriptions*、/api/scan（訂閱推播與掃描在 AWS 版由 notifier／dispatcher 負責）。
 *   - 原型的 last_tick 存在 scan_state；AWS 版改從 scan_log 推導，見 queries.ts 的 queryLastTick。
 *   - 參數格式錯誤時回 400，而不是讓 Postgres 的型別轉換錯誤變成 500
 *     （SQLite 的 exam_date 是 TEXT，原型拿任何字串比較都不會出錯）。
 *   - 未預期錯誤回 500 但不把內部錯誤訊息回給呼叫端，只寫進 log。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LICENSE_TYPES, OFFICES, STATIONS, STATION_BY_NO, OFFICE_BY_LV1 } from '../../../src/catalogue.ts';
import { releaseStats } from '../../../src/stats.ts';
import type { Queryable } from './db.ts';
import {
  queryAvailable,
  queryCombo,
  queryEvents,
  queryLastTick,
  queryOverview,
  queryStationEvents,
  queryStationScanLog,
  queryStationSlots,
  scanHealth,
} from './queries.ts';
import { STATIC } from './static.gen.ts';

/** 公開 GET 的快取秒數（CloudFront 依這個值快取） */
const PUBLIC_TTL = 30;
const STATS_DAYS = 30;

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

type Headers = Record<string, string>;
type Reply = { status: number; headers: Headers; body: string };

const json = (data: unknown, status = 200, extra: Headers = {}): Reply => ({
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  body: JSON.stringify(data),
});

/** 公開、可被任何網站 fetch、可快取的 JSON */
const publicJson = (data: unknown, status = 200) =>
  json(data, status, { ...CORS, 'Cache-Control': `public, max-age=${PUBLIC_TTL}` });

/** 純文字回應；和原型一樣不帶 Cache-Control（404 交給 CloudFront 的錯誤快取設定處理） */
const text = (body: string, status: number, extra: Headers = {}): Reply => ({
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  body,
});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 台灣日期 YYYY-MM-DD，和原型 src/scan.ts 的 todayIso 相同（不 import scan.ts，免得把爬蟲程式打包進來） */
export function todayIso(now: number = Date.now()): string {
  return new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 原型的寫法是 `q.get(x) ? Number(q.get(x)) : 預設值`；這裡另外擋掉 NaN，免得拼出 `LIMIT NaN`。
 * ±Infinity（例如 `limit=1e400`）照原型保留，交給 queries.ts 夾到上下限。
 */
function numParam(q: URLSearchParams, name: string, fallback: number): number {
  const raw = q.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export type AppOptions = {
  /** 取得資料庫連線池；第一次呼叫才建立（AWS 上要先讀 Secrets Manager） */
  getDb: () => Promise<Queryable>;
  /** 對外網址，給每站頁面的 canonical／og:url 與 sitemap 用；沒設就從請求標頭推 */
  publicOrigin?: string;
  now?: () => number;
};

/* ---------- 公開 GET 端點 ---------- */

async function publicApi(p: string, q: URLSearchParams, db: Queryable, now: number): Promise<Reply | null> {
  const today = todayIso(now);

  if (p === '/api') {
    return publicJson({
      name: 'mvdis-watch',
      description: '監理站考照場次餘額的公開 JSON API。資料每分鐘分批抓取自監理服務網，非即時，僅供參考。',
      cacheSeconds: PUBLIC_TTL,
      endpoints: {
        '/api/meta': '站別、照類對照與掃描健康度',
        '/api/available': '目前有餘額的場次。參數：dmvNo, licenseType, county, lv1, from, to, weekendOnly=1, minQuota, limit',
        '/api/overview': '每個「監理站 × 照類」目前有位的場次數與名額數',
        '/api/station?dmvNo=41': '單一監理站的完整場次表（含額滿）、每照類的釋位統計與最近事件',
        '/api/slots?licenseType=3&dmvNo=41': '單一「照類 × 監理站」的完整場次表',
        '/api/events': '最近的變化事件流。參數：kind, limit',
      },
      source: 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations',
    });
  }

  if (p === '/api/meta') {
    const [health, lastTick] = await Promise.all([scanHealth(db), queryLastTick(db)]);
    return publicJson({
      licenseTypes: LICENSE_TYPES,
      offices: OFFICES,
      stations: STATIONS,
      today,
      health,
      lastTick,
      serverTime: now,
    });
  }

  if (p === '/api/available') {
    const county = q.get('county') ?? undefined;
    const lv1 = q.get('lv1') ?? undefined;
    // 縣市與所別都是前端概念，轉成實際的 dmvNo 清單再查
    let dmvNos: string[] | undefined;
    if (county) dmvNos = STATIONS.filter((s) => s.county === county).map((s) => s.no);
    else if (lv1) dmvNos = STATIONS.filter((s) => s.lv1 === lv1).map((s) => s.no);

    // 原型：沒給 from 就用今天；給了空字串就是不設下限
    const from = q.get('from') ?? today;
    const to = q.get('to') ?? undefined;
    for (const [name, v] of [['from', from], ['to', to]] as const) {
      if (v && !isIsoDate(v)) return publicJson({ error: `${name} 需為 YYYY-MM-DD` }, 400);
    }

    const rows = await queryAvailable(
      db,
      {
        dmvNo: q.get('dmvNo') ?? undefined,
        licenseType: q.get('licenseType') ?? undefined,
        from,
        to,
        weekendOnly: q.get('weekendOnly') === '1',
        minQuota: numParam(q, 'minQuota', 1),
        limit: numParam(q, 'limit', 300),
      },
      dmvNos,
    );
    return publicJson({ rows, at: now });
  }

  // 分區總覽卡片與各篩選項目的數量。刻意不吃篩選條件（同原型）。
  if (p === '/api/overview') {
    return publicJson({ rows: await queryOverview(db, today), at: now });
  }

  if (p === '/api/events') {
    const rows = await queryEvents(db, q.get('kind'), numParam(q, 'limit', 80));
    return publicJson({ rows, at: now });
  }

  if (p === '/api/slots') {
    const licenseType = q.get('licenseType');
    const dmvNo = q.get('dmvNo');
    if (!licenseType || !dmvNo) return publicJson({ error: '需要 licenseType 與 dmvNo' }, 400);
    return publicJson({ rows: await queryCombo(db, licenseType, dmvNo), at: now });
  }

  // 每站頁面的一次到位資料：完整場次表（含額滿）、每照類釋位統計、最近事件、掃描健康度
  if (p === '/api/station') {
    const dmvNo = q.get('dmvNo') ?? '';
    const station = STATION_BY_NO.get(dmvNo);
    if (!station) return publicJson({ error: '找不到這個監理站，dmvNo 請參考 /api/meta' }, 404);
    const since = now - STATS_DAYS * 24 * 3600 * 1000;
    const [slots, events, scanLog, lastTick] = await Promise.all([
      queryStationSlots(db, dmvNo, today),
      queryStationEvents(db, dmvNo, since),
      queryStationScanLog(db, dmvNo),
      queryLastTick(db),
    ]);
    const stats = [...releaseStats(events, now, STATS_DAYS).values()];
    return publicJson({
      station,
      office: OFFICE_BY_LV1.get(station.lv1) ?? null,
      licenseTypes: LICENSE_TYPES,
      today,
      slots,
      stats,
      statsDays: STATS_DAYS,
      events: events.slice(0, 200),
      scanLog,
      lastTick,
      at: now,
    });
  }

  return null;
}

/* ---------- 頁面 ---------- */

function staticFile(name: string, req: IncomingMessage, maxAge = PUBLIC_TTL): Reply {
  const f = STATIC[name];
  const headers = { 'Content-Type': f.type, 'Cache-Control': `public, max-age=${maxAge}`, ETag: f.etag };
  if (req.headers['if-none-match'] === f.etag) return { status: 304, headers, body: '' };
  return { status: 200, headers, body: f.body };
}

/** 拿 station.html 注入標題與 OG 標籤（同原型的 stationPage） */
function stationPage(dmvNo: string, origin: string): Reply {
  const station = STATION_BY_NO.get(dmvNo);
  if (!station) return text('找不到這個監理站', 404);

  const title = `${station.name} 考照場次餘額`;
  const desc = `${station.name}（${station.address}）全部照類的考照場次表、目前餘額、釋位歷史統計。資料每分鐘分批抓取自監理服務網，非即時。`;
  const url = escapeHtml(`${origin}/station/${dmvNo}`);
  const head = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(desc)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(desc)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join('\n');

  return {
    status: 200,
    // 頁面殼是靜態的，資料由 /api/station 帶；殼本身可以快很久（同原型）
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    body: STATIC['station.html'].body.replace('<!--HEAD-->', head),
  };
}

function sitemap(origin: string): Reply {
  const urls = ['/', ...STATIONS.map((s) => `/station/${s.no}`)]
    .map((p) => `  <url><loc>${escapeHtml(origin + p)}</loc><changefreq>hourly</changefreq></url>`)
    .join('\n');
  return {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  };
}

function robots(origin: string): Reply {
  return text(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`, 200, {
    'Cache-Control': 'public, max-age=86400',
  });
}

/**
 * 對外網址，會被寫進 HTML 與 sitemap、再被 CloudFront 快取（sitemap 快取一天）。
 * **部署時應設 PUBLIC_ORIGIN**（CloudFront 網域）：CloudFront 預設不把瀏覽器的 Host 轉給 ALB，
 * 沒設的話這裡只拿得到 ALB 的網域。
 *
 * 沒設時的退路只看 Host，不信任 X-Forwarded-Host——它不在 CloudFront 的快取鍵裡，
 * 若 origin request policy 轉送了它，任何人都能用一個請求把假網域寫進快取。
 * Host 也只接受長得像主機名稱的值，其他一律退回 localhost。
 */
function originOf(req: IncomingMessage, configured?: string): string {
  if (configured) return configured.replace(/\/+$/, '');
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim();
  const proto = first(req.headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
  const host = first(req.headers.host) || '';
  return `${proto}://${/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : 'localhost'}`;
}

/* ---------- 路由 ---------- */

async function route(req: IncomingMessage, opts: AppOptions): Promise<Reply> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  const q = url.searchParams;
  const isGet = req.method === 'GET' || req.method === 'HEAD';

  if (req.method === 'OPTIONS' && p.startsWith('/api/')) return { status: 204, headers: CORS, body: '' };

  // ALB 健康檢查：連得到 DB 才算健康，否則讓 ALB 把這台摘掉
  if (p === '/healthz') {
    try {
      const db = await opts.getDb();
      await db.query('SELECT 1');
      return json({ ok: true });
    } catch (e) {
      console.error('healthz: db unavailable:', e instanceof Error ? e.message : e);
      return json({ ok: false, error: 'database unavailable' }, 503);
    }
  }

  if (p === '/api' || p.startsWith('/api/')) {
    if (isGet) {
      const res = await publicApi(p, q, await opts.getDb(), (opts.now ?? Date.now)());
      if (res) return res;
    }
    return json({ error: 'not found' }, 404);
  }

  if (!isGet) return text('Method not allowed', 405, { Allow: 'GET, HEAD' });

  if (p === '/sitemap.xml') return sitemap(originOf(req, opts.publicOrigin));
  if (p === '/robots.txt') return robots(originOf(req, opts.publicOrigin));

  const station = p.match(/^\/station\/(\d{2})\/?$/);
  if (station) return stationPage(station[1], originOf(req, opts.publicOrigin));

  if (p === '/' || p === '/index.html') return staticFile('index.html', req);
  // 原型的 station.js 也支援 /station.html?no=41 這種舊網址
  const name = p.slice(1);
  if (name === 'station.html' || name === 'app.js' || name === 'station.js' || name === 'style.css') {
    return staticFile(name, req);
  }

  return text('Not found', 404);
}

export function createHandler(opts: AppOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let reply: Reply;
    try {
      reply = await route(req, opts);
    } catch (e) {
      console.error(`${req.method} ${req.url} failed:`, e);
      reply = json({ error: 'internal error' }, 500);
    }
    const body = Buffer.from(reply.body, 'utf8');
    res.writeHead(reply.status, { ...reply.headers, 'Content-Length': String(body.length) });
    res.end(req.method === 'HEAD' || reply.status === 204 || reply.status === 304 ? undefined : body);
  };
}
