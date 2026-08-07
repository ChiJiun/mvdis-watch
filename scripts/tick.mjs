/**
 * 本機排程器。
 *
 * `wrangler dev --test-scheduled` 只是開出 /__scheduled 端點，並不會自己定時觸發，
 * 所以本機跑的話需要有人每分鐘去戳它一下 —— 就是這支。
 * 它走的是跟正式環境完全相同的 scheduled() 程式路徑，只是換成由這裡驅動 cron。
 *
 *   npm run dev     另一個終端機先起服務
 *   npm run tick    這支負責每分鐘觸發一次
 */
const PORT = process.env.PORT ?? '8788';
const URL_ = `http://127.0.0.1:${PORT}/__scheduled`;
const EVERY_MS = 60_000;

const stamp = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });

async function tick() {
  const t0 = Date.now();
  try {
    const res = await fetch(URL_);
    if (!res.ok) {
      console.log(`${stamp()}  HTTP ${res.status} —— 服務有起來嗎？（npm run dev）`);
      return;
    }
    // scheduled() 是在 waitUntil 裡跑的，回應本身不帶結果，統計要看 dev 那邊的 log
    console.log(`${stamp()}  已觸發一輪掃描（${Date.now() - t0}ms）`);
  } catch {
    console.log(`${stamp()}  連不上 ${URL_} —— 請先在另一個終端機執行 npm run dev`);
  }
}

console.log(`每 ${EVERY_MS / 1000} 秒觸發一次 ${URL_}，Ctrl+C 停止`);
await tick();
setInterval(tick, EVERY_MS);
