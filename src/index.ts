/**
 * Worker 進入點：同時是 cron 抓取器、公開 API、每站頁面的伺服端注入。
 * 靜態前端由 [assets] 直接服務；只有 /api/*、/station/:no、/sitemap.xml、/robots.txt 會進到這裡。
 *
 * 公開 GET 端點全部走 30 秒的邊緣快取（Cache API）。這個網站掛在公開網域上，
 * 沒有快取的話每個訪客每 30 秒重讀一次 D1，熱門時段很快就會撞到免費方案的
 * 每日讀取列數上限；有了快取，不管多少人開著頁面，D1 每 30 秒最多只被讀一次。
 */
import { LICENSE_TYPES, OFFICES, STATIONS, STATION_BY_NO, OFFICE_BY_LV1, type Station } from './catalogue.ts';
import { STATION_INFO, STATION_INFO_SOURCE } from './station-info.ts';
import { runScanTick, todayIso, type Env as ScanEnv } from './scan.ts';
import {
  queryAvailable,
  queryEvents,
  queryCombo,
  scanHealth,
  getStates,
  queryStationSlots,
  queryStationEvents,
  queryStationScanLog,
} from './db.ts';
import { releaseStats } from './stats.ts';

type Env = ScanEnv & { ASSETS: Fetcher; SCAN_TOKEN?: string; ADMIN_TOKEN?: string };

/** 公開 GET 的快取秒數。儀表板每 30 秒重讀一次，再短也沒有意義。 */
const PUBLIC_TTL = 30;
const STATS_DAYS = 30;

/**
 * 訂閱端點必須鎖住。Discord webhook URL 等同密鑰——任何人拿到就能往你的
 * 頻道發訊息——而這個網站是掛在公開網域上的，端點預設全世界都打得到。
 */
function authed(req: Request, env: Env): boolean {
  const token = env.ADMIN_TOKEN || env.SCAN_TOKEN;
  return Boolean(token) && req.headers.get('x-admin-token') === token;
}

/** 回給前端時只留尾巴，避免整條 webhook URL 從 API 漏出去 */
function maskTarget(t: string): string {
  return t.length <= 12 ? '***' : `${t.slice(0, 34)}…${t.slice(-6)}`;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });

/** 公開、可被任何網站 fetch、可快取的 JSON */
const publicJson = (data: unknown, status = 200) =>
  json(data, status, { ...CORS, 'Cache-Control': `public, max-age=${PUBLIC_TTL}` });

/** 站別對照表加上開放資料的電話、傳真、所轄區域；對不到資料的站這三欄就是 undefined */
const withInfo = (s: Station) => ({ ...s, ...STATION_INFO[s.no] });
const STATIONS_WITH_INFO = STATIONS.map(withInfo);

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/* ---------- 公開 GET 端點 ---------- */

async function publicApi(p: string, q: URLSearchParams, env: Env): Promise<Response | null> {
  if (p === '/api') {
    return publicJson({
      name: 'mvdis-watch',
      description: '監理站考照場次餘額的公開 JSON API。資料每分鐘分批抓取自監理服務網，非即時，僅供參考。',
      cacheSeconds: PUBLIC_TTL,
      endpoints: {
        '/api/meta': '站別（含電話、傳真、所轄區域）、照類對照與掃描健康度',
        '/api/available': '目前有餘額的場次。參數：dmvNo, licenseType, county, lv1, from, to, weekendOnly=1, minQuota, limit',
        '/api/overview': '每個「監理站 × 照類」目前有位的場次數與名額數',
        '/api/station?dmvNo=41': '單一監理站的基本資料、完整場次表（含額滿）、每照類的釋位統計與最近事件',
        '/api/slots?licenseType=3&dmvNo=41': '單一「照類 × 監理站」的完整場次表',
        '/api/events': '最近的變化事件流。參數：kind, limit',
      },
      source: 'https://www.mvdis.gov.tw/m3-emv-trn/exm/locations',
      stationInfoSource: STATION_INFO_SOURCE,
    });
  }

  if (p === '/api/meta') {
    const [health, state] = await Promise.all([scanHealth(env.DB), getStates(env.DB, ['last_tick'])]);
    const lastTick = state.get('last_tick') ?? null;
    return publicJson({
      licenseTypes: LICENSE_TYPES,
      offices: OFFICES,
      stations: STATIONS_WITH_INFO,
      stationInfoSource: STATION_INFO_SOURCE,
      today: todayIso(),
      health,
      lastTick: lastTick ? Number(lastTick) : null,
      serverTime: Date.now(),
    });
  }

  if (p === '/api/available') {
    const county = q.get('county') ?? undefined;
    const lv1 = q.get('lv1') ?? undefined;
    // 縣市與所別都是前端概念，轉成實際的 dmvNo 清單再查
    let dmvNos: string[] | undefined;
    if (county) dmvNos = STATIONS.filter((s) => s.county === county).map((s) => s.no);
    else if (lv1) dmvNos = STATIONS.filter((s) => s.lv1 === lv1).map((s) => s.no);

    const rows = await queryAvailable(
      env.DB,
      {
        dmvNo: q.get('dmvNo') ?? undefined,
        licenseType: q.get('licenseType') ?? undefined,
        from: q.get('from') ?? todayIso(),
        to: q.get('to') ?? undefined,
        weekendOnly: q.get('weekendOnly') === '1',
        minQuota: q.get('minQuota') ? Number(q.get('minQuota')) : 1,
        limit: q.get('limit') ? Number(q.get('limit')) : 300,
      },
      dmvNos,
    );
    return publicJson({ rows, at: Date.now() });
  }

  // 分區總覽卡片與各篩選項目的數量。刻意不吃篩選條件——卡片要顯示的是
  // 「全國哪裡還有位」的完整樣貌，被自己的篩選條件縮限就沒意義了。
  if (p === '/api/overview') {
    const r = await env.DB
      .prepare(
        `SELECT dmv_no, license_type, COUNT(*) AS slots, SUM(quota) AS seats, MIN(exam_date) AS nearest
         FROM slot WHERE quota > 0 AND exam_date >= ?
         GROUP BY dmv_no, license_type`,
      )
      .bind(todayIso())
      .all();
    return publicJson({ rows: r.results ?? [], at: Date.now() });
  }

  if (p === '/api/events') {
    const rows = await queryEvents(env.DB, q.get('kind'), q.get('limit') ? Number(q.get('limit')) : 80);
    return publicJson({ rows, at: Date.now() });
  }

  if (p === '/api/slots') {
    const licenseType = q.get('licenseType');
    const dmvNo = q.get('dmvNo');
    if (!licenseType || !dmvNo) return publicJson({ error: '需要 licenseType 與 dmvNo' }, 400);
    return publicJson({ rows: await queryCombo(env.DB, licenseType, dmvNo), at: Date.now() });
  }

  // 每站頁面的一次到位資料：完整場次表（含額滿）、每照類釋位統計、最近事件、掃描健康度
  if (p === '/api/station') {
    const dmvNo = q.get('dmvNo') ?? '';
    const station = STATION_BY_NO.get(dmvNo);
    if (!station) return publicJson({ error: '找不到這個監理站，dmvNo 請參考 /api/meta' }, 404);
    const now = Date.now();
    const since = now - STATS_DAYS * 24 * 3600 * 1000;
    const [slots, events, scanLog, state] = await Promise.all([
      queryStationSlots(env.DB, dmvNo, todayIso()),
      queryStationEvents(env.DB, dmvNo, since),
      queryStationScanLog(env.DB, dmvNo),
      getStates(env.DB, ['last_tick']),
    ]);
    const stats = [...releaseStats(events, now, STATS_DAYS).values()];
    const lastTick = state.get('last_tick');
    return publicJson({
      station: withInfo(station),
      stationInfoSource: STATION_INFO_SOURCE,
      office: OFFICE_BY_LV1.get(station.lv1) ?? null,
      licenseTypes: LICENSE_TYPES,
      today: todayIso(),
      slots,
      stats,
      statsDays: STATS_DAYS,
      events: events.slice(0, 200),
      scanLog,
      lastTick: lastTick ? Number(lastTick) : null,
      at: now,
    });
  }

  return null;
}

/* ---------- 每站頁面：拿 station.html 注入標題與 OG 標籤 ---------- */

async function stationPage(req: Request, env: Env, dmvNo: string, origin: string): Promise<Response> {
  const station = STATION_BY_NO.get(dmvNo);
  if (!station) return new Response('找不到這個監理站', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

  const asset = await env.ASSETS.fetch(new Request(`${origin}/station.html`, { headers: req.headers }));
  if (!asset.ok) return new Response('station.html missing', { status: 500 });

  const title = `${station.name} 考照場次餘額`;
  const info = STATION_INFO[station.no];
  const desc = `${station.name}（${station.address}${info ? `，電話 ${info.phone}` : ''}）全部照類的考照場次表、目前餘額、釋位歷史統計。資料每分鐘分批抓取自監理服務網，非即時。`;
  const url = `${origin}/station/${dmvNo}`;
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

  const html = (await asset.text()).replace('<!--HEAD-->', head);
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // 頁面殼是靜態的，資料由 /api/station 帶；殼本身可以快很久
      'Cache-Control': 'public, max-age=300',
    },
  });
}

function sitemap(origin: string): Response {
  const urls = ['/', ...STATIONS.map((s) => `/station/${s.no}`)]
    .map((p) => `  <url><loc>${origin}${p}</loc><changefreq>hourly</changefreq></url>`)
    .join('\n');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
  });
}

function robots(origin: string): Response {
  // API 回應沒必要被搜尋引擎索引，而且會白白消耗 D1 讀取量
  return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const q = url.searchParams;

    try {
      if (req.method === 'OPTIONS' && p.startsWith('/api/')) {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (p === '/sitemap.xml') return sitemap(url.origin);
      if (p === '/robots.txt') return robots(url.origin);

      const station = p.match(/^\/station\/(\d{2})\/?$/);
      if (station && req.method === 'GET') return stationPage(req, env, station[1], url.origin);

      // 公開 GET：先問邊緣快取，沒有才查 D1，查完放回快取
      if (req.method === 'GET' && (p === '/api' || p.startsWith('/api/'))) {
        const cache = caches.default;
        const key = new Request(url.toString(), { method: 'GET' });
        const hit = await cache.match(key);
        if (hit) return hit;
        const res = await publicApi(p, q, env);
        if (res) {
          if (res.ok) ctx.waitUntil(cache.put(key, res.clone()));
          return res;
        }
      }

      /* ---------- 通知訂閱（全部需要 ADMIN_TOKEN） ---------- */

      if (p === '/api/subscriptions') {
        if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);

        if (req.method === 'GET') {
          const subs = await env.DB
            .prepare('SELECT id, kind, target, label, active, created_at, last_sent_at, last_error FROM subscription ORDER BY id')
            .all<{ id: number; target: string }>();
          const watches = await env.DB
            .prepare('SELECT subscription_id, license_type, dmv_no FROM subscription_watch')
            .all<{ subscription_id: number; license_type: string; dmv_no: string }>();
          const byId = new Map<number, Array<{ licenseType: string; dmvNo: string }>>();
          for (const w of watches.results ?? []) {
            if (!byId.has(w.subscription_id)) byId.set(w.subscription_id, []);
            byId.get(w.subscription_id)!.push({ licenseType: w.license_type, dmvNo: w.dmv_no });
          }
          const rows = (subs.results ?? []).map((s) => ({
            ...s,
            target: maskTarget(s.target),
            watches: byId.get(s.id) ?? [],
          }));
          return json({ rows });
        }

        if (req.method === 'POST') {
          const body = (await req.json()) as {
            target?: string;
            label?: string;
            watches?: Array<{ licenseType: string; dmvNo: string }>;
          };
          const target = (body.target ?? '').trim();
          if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(target)) {
            return json({ error: '請貼上 Discord webhook 網址（https://discord.com/api/webhooks/…）' }, 400);
          }
          const ins = await env.DB
            .prepare('INSERT INTO subscription (kind, target, label, created_at) VALUES (?,?,?,?) RETURNING id')
            .bind('discord', target, body.label ?? null, Date.now())
            .first<{ id: number }>();
          const id = ins!.id;

          const watches = (body.watches ?? []).slice(0, 200);
          if (watches.length) {
            const values = watches.map(() => '(?,?,?)').join(',');
            await env.DB
              .prepare(`INSERT OR IGNORE INTO subscription_watch (subscription_id, license_type, dmv_no) VALUES ${values}`)
              .bind(...watches.flatMap((w) => [id, w.licenseType, w.dmvNo]))
              .run();
          }
          return json({ id, watches: watches.length });
        }

        if (req.method === 'DELETE') {
          const id = Number(q.get('id'));
          if (!id) return json({ error: '需要 id' }, 400);
          await env.DB.batch([
            env.DB.prepare('DELETE FROM subscription_watch WHERE subscription_id = ?').bind(id),
            env.DB.prepare('DELETE FROM subscription WHERE id = ?').bind(id),
          ]);
          return json({ deleted: id });
        }
        return json({ error: 'method not allowed' }, 405);
      }

      // 送一則測試訊息，確認 webhook 真的通得到你的頻道
      if (p === '/api/subscriptions/test' && req.method === 'POST') {
        if (!authed(req, env)) return json({ error: 'unauthorized' }, 401);
        const id = Number(q.get('id'));
        const sub = await env.DB
          .prepare('SELECT target FROM subscription WHERE id = ?')
          .bind(id)
          .first<{ target: string }>();
        if (!sub) return json({ error: '找不到這個訂閱' }, 404);
        const res = await fetch(sub.target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: '監理站餘額監測',
            embeds: [
              {
                title: '🛵 測試訊息',
                description: '綁定成功。之後只要你追蹤的場次從「額滿」變成有位，就會推到這裡。',
                color: 0x0b6bcb,
              },
            ],
          }),
        });
        return json({ ok: res.ok || res.status === 204, status: res.status });
      }

      // 手動觸發一輪掃描，給本機開發與部署後的第一次暖機用。
      // 有 token 才放行，否則這支端點會變成別人拿來打監理站的跳板。
      if (p === '/api/scan' && req.method === 'POST') {
        if (!env.SCAN_TOKEN || req.headers.get('x-scan-token') !== env.SCAN_TOKEN) {
          return json({ error: 'unauthorized' }, 401);
        }
        return json(await runScanTick(env));
      }

      if (p === '/api' || p.startsWith('/api/')) return json({ error: 'not found' }, 404);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, 500);
    }
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScanTick(env).then(
        (r) => console.log('scan', JSON.stringify(r)),
        (e) => console.error('scan failed', e),
      ),
    );
  },
};
