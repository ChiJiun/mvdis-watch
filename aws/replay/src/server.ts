/**
 * Replay 模擬站的 HTTP 層（契約第 8 節）：
 *   GET  /healthz                     ALB 健康檢查
 *   POST /m3-emv-trn/exm/locations    和官網相同的表單欄位，回傳同格式 HTML
 *   POST /admin/reset                 還原成 seed 決定的初始狀態（可帶 JSON 換參數）
 *   GET  /admin/stats                 目前狀態與計數（實驗腳本用）
 *   GET  /admin/events                擾動紀錄，E3 用來算「釋位發生 → 被偵測」的延遲
 *
 * 只用 node:http，不引入框架，打包後是單一檔案。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { renderPage, type FlipEvent, type PageTemplate, type ReplayConfig, ReplayState } from './generator.ts';

export const LOCATIONS_PATH = '/m3-emv-trn/exm/locations';
const MAX_BODY = 16 * 1024;

export type ServerOptions = {
  /** 模擬官網回應時間：每次回應等待 delayMs ± jitterMs（均勻分布） */
  delayMs: number;
  jitterMs: number;
  /** 有值時 /admin/* 需要帶 `x-admin-token` 標頭 */
  adminToken: string | null;
};

export type ResetBody = Partial<ReplayConfig> & Partial<Pick<ServerOptions, 'delayMs' | 'jitterMs'>>;

const CONFIG_KEYS: Array<keyof ReplayConfig> = ['seed', 'flipProb', 'tickMs', 'flipsPerTick', 'fullRatio', 'horizonDays', 'maxEvents'];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res: ServerResponse, status: number, obj: unknown) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
const text = (res: ServerResponse, status: number, msg: string) => send(res, status, msg, 'text/plain; charset=utf-8');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 驗證 /admin/reset 的 JSON，只接受已知欄位與合理範圍，避免一個錯字把實驗跑歪 */
export function validateReset(raw: unknown): ResetBody {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body 必須是 JSON 物件');
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(CONFIG_KEYS as string[]).includes(k) && k !== 'delayMs' && k !== 'jitterMs') throw new Error(`未知欄位：${k}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} 必須是數字`);
    if ((k === 'flipProb' || k === 'fullRatio') && (v < 0 || v > 1)) throw new Error(`${k} 必須介於 0 和 1`);
    if (k !== 'seed' && k !== 'flipProb' && k !== 'fullRatio' && v < 0) throw new Error(`${k} 不能是負數`);
    out[k] = v;
  }
  return out as ResetBody;
}

export type ReplayServer = { server: Server; state: ReplayState; options: ServerOptions; stopClock: () => void };

export function createReplayServer(state: ReplayState, template: PageTemplate, options: ServerOptions): ReplayServer {
  let timer: ReturnType<typeof setInterval> | null = null;
  const startClock = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (state.config.tickMs > 0) {
      timer = setInterval(() => state.tick(Date.now()), state.config.tickMs);
      timer.unref();
    }
  };
  const stopClock = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const authorized = (req: IncomingMessage) => !options.adminToken || req.headers['x-admin-token'] === options.adminToken;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://replay.local');
    const path = url.pathname;

    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      return json(res, 200, { ok: true, combos: state.combos.size, requests: state.requests, uptimeMs: Math.round(process.uptime() * 1000) });
    }

    if (path === LOCATIONS_PATH) {
      if (req.method !== 'POST') return text(res, 405, 'method not allowed');
      const form = new URLSearchParams(await readBody(req));
      const method = form.get('method');
      const licenseType = form.get('licenseTypeCode');
      const lv1 = form.get('dmvNoLv1');
      const dmvNo = form.get('dmvNo');
      if (method !== 'query') return text(res, 400, `replay 只支援 method=query（收到 ${method}）`);
      if (!licenseType || !lv1 || !dmvNo) return text(res, 400, '缺少 licenseTypeCode / dmvNoLv1 / dmvNo');

      state.requests++;
      const wait = options.delayMs + (options.jitterMs > 0 ? (Math.random() * 2 - 1) * options.jitterMs : 0);
      if (wait > 0) await sleep(wait);

      // 擾動發生在「產生回應的那一刻」，所以這次回應就反映翻轉後的名額
      const combo = state.lookup(licenseType, lv1, dmvNo);
      if (combo) state.perturbOnRequest(combo, Date.now());
      return send(res, 200, renderPage(template, combo?.slots ?? []), 'text/html;charset=UTF-8');
    }

    if (path.startsWith('/admin/')) {
      if (!authorized(req)) return text(res, 401, 'unauthorized');

      if (path === '/admin/reset' && req.method === 'POST') {
        const raw = (await readBody(req)).trim();
        let patch: ResetBody;
        try {
          patch = raw ? validateReset(JSON.parse(raw)) : {};
        } catch (e) {
          return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
        const { delayMs, jitterMs, ...cfg } = patch;
        if (delayMs !== undefined) options.delayMs = delayMs;
        if (jitterMs !== undefined) options.jitterMs = jitterMs;
        state.reset(cfg);
        startClock();
        return json(res, 200, { ok: true, ...state.stats(), delayMs: options.delayMs, jitterMs: options.jitterMs });
      }

      if (path === '/admin/stats' && req.method === 'GET') {
        return json(res, 200, { ...state.stats(), delayMs: options.delayMs, jitterMs: options.jitterMs });
      }

      if (path === '/admin/events' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? '0') || 0;
        const k = url.searchParams.get('kind');
        const kind = k === 'released' || k === 'filled' ? (k as FlipEvent['kind']) : null;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? '5000') || 5000, 1), 50_000);
        const events = state.eventsAfter(after, kind, limit);
        return json(res, 200, { events, lastSeq: state.stats().lastSeq });
      }
    }

    return text(res, 404, 'not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) text(res, 500, e instanceof Error ? e.message : String(e));
      else res.destroy();
    });
  });
  server.on('close', stopClock);
  startClock();
  return { server, state, options, stopClock };
}
