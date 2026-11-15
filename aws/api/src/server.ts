/**
 * 進入點：EC2 上由 systemd 執行 `node api.mjs`。設定全部來自環境變數（見 db.ts 與 aws/CONTRACTS.md）。
 */
import { createServer } from 'node:http';
import type pg from 'pg';
import { createHandler } from './app.ts';
import { createPool } from './db.ts';

const port = Number(process.env.PORT || 8080);

/**
 * 連線池延遲建立：AWS 上要先讀 Secrets Manager，失敗（例如 Learner Lab 憑證剛換）時
 * 不讓整個 process 起不來，而是讓 /healthz 回 503、下一個請求再試一次。
 */
let poolPromise: Promise<pg.Pool> | null = null;
function getDb(): Promise<pg.Pool> {
  if (!poolPromise) {
    poolPromise = createPool().catch((e) => {
      poolPromise = null;
      throw e;
    });
  }
  return poolPromise;
}

const server = createServer(createHandler({ getDb, publicOrigin: process.env.PUBLIC_ORIGIN || undefined }));

// ALB 的閒置逾時預設 60 秒。Node 的 keep-alive 預設只有 5 秒，比 ALB 短的話，
// ALB 會把請求送進一條 Node 剛關掉的連線而回 502——高併發壓測時特別明顯。
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(port, () => console.log(`mvdis-api listening on :${port}`));
// 先暖機連線池，讓第一個健康檢查不用等 Secrets Manager
getDb().catch((e) => console.error('initial db connect failed:', e instanceof Error ? e.message : e));

// ASG 縮容或 systemd stop 時送 SIGTERM：停止收新連線、等進行中的請求做完再關連線池
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  server.close(async () => {
    try {
      if (poolPromise) await (await poolPromise).end();
    } catch {
      /* 關閉時的錯誤不影響結束 */
    }
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
