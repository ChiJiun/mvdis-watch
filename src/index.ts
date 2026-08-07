/**
 * Worker 進入點：同時是 cron 抓取器與儀表板 API。
 * 靜態前端由 [assets] 直接服務，只有 /api/* 會進到這裡。
 */
import { LICENSE_TYPES, OFFICES, STATIONS } from './catalogue.ts';
import { runScanTick, todayIso, type Env as ScanEnv } from './scan.ts';
import { queryAvailable, queryEvents, queryCombo, scanHealth, getStates } from './db.ts';

type Env = ScanEnv & { SCAN_TOKEN?: string; ADMIN_TOKEN?: string };

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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const q = url.searchParams;

    try {
      if (p === '/api/meta') {
        const [health, state] = await Promise.all([scanHealth(env.DB), getStates(env.DB, ['last_tick'])]);
        const lastTick = state.get('last_tick') ?? null;
        return json({
          licenseTypes: LICENSE_TYPES,
          offices: OFFICES,
          stations: STATIONS,
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
        return json({ rows, at: Date.now() });
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
        return json({ rows: r.results ?? [], at: Date.now() });
      }

      if (p === '/api/events') {
        const rows = await queryEvents(env.DB, q.get('kind'), q.get('limit') ? Number(q.get('limit')) : 80);
        return json({ rows, at: Date.now() });
      }

      if (p === '/api/slots') {
        const licenseType = q.get('licenseType');
        const dmvNo = q.get('dmvNo');
        if (!licenseType || !dmvNo) return json({ error: '需要 licenseType 與 dmvNo' }, 400);
        return json({ rows: await queryCombo(env.DB, licenseType, dmvNo), at: Date.now() });
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

      if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
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
