/**
 * 單機部署用的 live 轉發器（Cloudflare Worker）。
 *
 * 為什麼需要：監理服務網會丟掉部分海外 IP 的連線（實測 Oracle 東京 VM 的 IPv4 連線逾時），
 * 單機版的 worker 改把 MVDIS_LIVE_URL 指向這個 Worker，由 Cloudflare 代為發出請求。
 *
 * 只做最小的事，避免變成開放代理：
 *   - 只接受 ALLOWED_IPS 裡的來源 IP（CF-Connecting-IP）；沒設定就全部拒絕（fail-closed）
 *   - 只轉發到 https://www.mvdis.gov.tw 的查詢端點（固定路徑），只允許 GET／POST
 *   - 只轉送必要的標頭，POST body 上限 4 KB，不轉送 cookie 與 query
 * 每分鐘的請求量由 VM 上的 scheduler 控制（契約 §3：每分鐘最多 14 則），這裡不另外限速。
 *
 * 部署（ALLOWED_IPS 不寫進 repo）：
 *   npx wrangler deploy --var ALLOWED_IPS:<VM 的公開 IPv4>
 */

const ORIGIN = 'https://www.mvdis.gov.tw';
/** 和 aws/shared/contracts.ts 的 MVDIS_PATH 相同 */
const MVDIS_PATH = '/m3-emv-trn/exm/locations';
const MAX_BODY_BYTES = 4096;
const FORWARD_HEADERS = ['content-type', 'user-agent', 'accept-language'];

export interface Env {
  /** 逗號分隔的來源 IP 白名單 */
  ALLOWED_IPS?: string;
}

function text(status: number, msg: string): Response {
  return new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export function allowedIps(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const ip = req.headers.get('cf-connecting-ip') ?? '';
    if (!allowedIps(env.ALLOWED_IPS).has(ip)) return text(403, 'forbidden');

    const url = new URL(req.url);
    if (url.pathname !== MVDIS_PATH) return text(404, 'not found');
    if (req.method !== 'GET' && req.method !== 'POST') return text(405, 'method not allowed');

    let body: ArrayBuffer | undefined;
    if (req.method === 'POST') {
      body = await req.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return text(413, 'body too large');
    }

    const headers = new Headers();
    for (const h of FORWARD_HEADERS) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('referer', ORIGIN + MVDIS_PATH);

    // 不轉送 query：worker 從不帶 query，上游網址固定為常數
    let upstream: Response;
    try {
      upstream = await fetch(ORIGIN + MVDIS_PATH, {
        method: req.method,
        headers,
        body,
        redirect: 'follow',
      });
    } catch {
      return text(502, 'upstream error');
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/html; charset=utf-8' },
    });
  },
} satisfies ExportedHandler<Env>;
