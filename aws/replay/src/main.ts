/**
 * Replay 模擬站進入點：`node dist/replay.mjs`。
 * 模板（真實頁面）在 build 時以文字嵌入，EC2 上不需要額外檔案。
 */
import templateHtml from '../fixtures/raw/available.html';
import { loadConfig } from './config.ts';
import { ReplayState, splitTemplate } from './generator.ts';
import { createReplayServer } from './server.ts';

const { port, config, options } = loadConfig(process.env);
const state = new ReplayState(config);
const { server } = createReplayServer(state, splitTemplate(templateHtml), options);

server.listen(port, () => {
  const s = state.stats();
  console.log(
    JSON.stringify({
      msg: 'replay listening',
      port,
      combos: s.combos,
      slots: s.slots,
      emptyCombos: s.emptyCombos,
      config,
      delayMs: options.delayMs,
      jitterMs: options.jitterMs,
      adminAuth: options.adminToken !== null,
    }),
  );
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
