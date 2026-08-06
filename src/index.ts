/**
 * Worker 進入點：同時是 cron 抓取器與儀表板 API。
 * 靜態前端由 [assets] 直接服務，只有 /api/* 會進到這裡。
 */
import { LICENSE_TYPES, OFFICES, STATIONS } from './catalogue.ts';
import { runScanTick, todayIso, type Env as ScanEnv } from './scan.ts';
import { queryAvailable, queryEvents, queryCombo, scanHealth, getState } from './db.ts';

type Env = ScanEnv & { SCAN_TOKEN?: string };

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
        const [health, lastTick] = await Promise.all([scanHealth(env.DB), getState(env.DB, 'last_tick')]);
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
