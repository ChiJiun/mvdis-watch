import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLD,
  HOT,
  deterministicTaskId,
  dispatchConfig,
  epochMinute,
  planTick,
  segment,
} from '../src/dispatcher/plan.ts';
import { dispatch } from '../src/dispatcher/index.ts';
import { LIVE_MAX_TASKS_PER_MINUTE, type ScanTask } from '../../shared/contracts.ts';

const key = (t: { licenseType: string; dmvNo: string }) => `${t.licenseType}|${t.dmvNo}`;
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

test('熱門／冷門組合數與原型一致', () => {
  assert.equal(HOT.length, 108);
  assert.equal(COLD.length, 252);
});

test('連續 10 分鐘輪完全部 108 個熱門組合；連續 84 分鐘輪完 252 個冷門組合', () => {
  const { config } = dispatchConfig({});
  const hot = new Set<string>();
  const cold = new Set<string>();
  for (let i = 0; i < 84; i++) {
    for (const t of planTick(T0 + i * 60_000, config)) (t.tier === 'hot' ? hot : cold).add(key(t));
    if (i === 9) assert.equal(hot.size, 108, '10 分鐘內熱門要全部輪到');
  }
  assert.equal(cold.size, 252, '84 分鐘內冷門要全部輪到');
});

test('分段是無狀態的：同一分鐘內任何時間點算出來都一樣，連續分鐘首尾相接', () => {
  const { config } = dispatchConfig({});
  const a = planTick(T0 + 1_000, config);
  const b = planTick(T0 + 59_999, config);
  assert.deepEqual(a.map((t) => t.taskId), b.map((t) => t.taskId));

  const m = epochMinute(T0);
  const s1 = segment(HOT, m, 11);
  const s2 = segment(HOT, m + 1, 11);
  const i1 = HOT.indexOf(s1[10]);
  assert.equal(HOT.indexOf(s2[0]), (i1 + 1) % HOT.length);
});

test('segment：跨過尾端會繞回、不超過清單長度、不重複', () => {
  const list = [0, 1, 2, 3, 4];
  assert.deepEqual(segment(list, 1, 3), [3, 4, 0]);
  assert.deepEqual(segment(list, 0, 10), [0, 1, 2, 3, 4]);
  assert.deepEqual(segment(list, 7, 0), []);
  assert.deepEqual(segment([], 7, 3), []);
});

test('預設每分鐘 11 熱門 + 3 冷門 = 14 則，欄位符合契約', () => {
  const { config, warnings } = dispatchConfig({});
  assert.deepEqual(warnings, []);
  const tasks = planTick(T0, config);
  assert.equal(tasks.length, 14);
  assert.equal(tasks.filter((t) => t.tier === 'hot').length, 11);
  for (const t of tasks) {
    assert.equal(t.v, 1);
    assert.equal(t.target, 'live');
    assert.equal(t.runId, null);
    assert.equal(t.enqueuedAt, T0);
    assert.match(t.taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.equal(new Set(tasks.map((t) => t.taskId)).size, 14);
});

test('live 上限：不管環境變數怎麼設，live 每分鐘都不超過 14 則', () => {
  const cases: Array<Record<string, string>> = [
    { HOT_PER_TICK: '20', COLD_PER_TICK: '20' },
    { HOT_PER_TICK: '14', COLD_PER_TICK: '1' },
    { HOT_PER_TICK: '1000' },
    { COLD_PER_TICK: '1000' },
    { HOT_PER_TICK: '12', COLD_PER_TICK: '3', SCAN_TARGET: 'live' },
    { HOT_PER_TICK: '50', SCAN_TARGET: 'LIVE' }, // 不認得的值當 live
    { HOT_PER_TICK: '50', SCAN_TARGET: '' },
    { HOT_PER_TICK: '-5', COLD_PER_TICK: 'abc' }, // 壞值退回預設 11+3
  ];
  for (const env of cases) {
    const { config } = dispatchConfig(env);
    assert.equal(config.target, 'live', JSON.stringify(env));
    for (let i = 0; i < 30; i++) {
      const n = planTick(T0 + i * 60_000, config).length;
      assert.ok(n <= LIVE_MAX_TASKS_PER_MINUTE, `${JSON.stringify(env)} 第 ${i} 分鐘送了 ${n} 則`);
    }
  }
  const { config, warnings } = dispatchConfig({ HOT_PER_TICK: '12', COLD_PER_TICK: '5' });
  assert.deepEqual([config.hotPerTick, config.coldPerTick], [12, 2], '先砍冷門');
  assert.equal(warnings.length, 1);
});

test('planTick 的最後防線：就算 config 被手動塞超過上限，live 也會截到 14', () => {
  const tasks = planTick(T0, { target: 'live', hotPerTick: 100, coldPerTick: 100 });
  assert.equal(tasks.length, LIVE_MAX_TASKS_PER_MINUTE);
});

test('replay 模式不受 14 則限制', () => {
  const { config } = dispatchConfig({ SCAN_TARGET: 'replay', HOT_PER_TICK: '108', COLD_PER_TICK: '252' });
  const tasks = planTick(T0, config);
  assert.equal(tasks.length, 360);
  assert.ok(tasks.every((t) => t.target === 'replay'));
});

test('taskId 由（分鐘, 層, 目標, 組合）決定：EventBridge 重複觸發會得到相同 taskId', () => {
  const c = HOT[0];
  assert.equal(deterministicTaskId(5, 'hot', 'live', c), deterministicTaskId(5, 'hot', 'live', c));
  assert.notEqual(deterministicTaskId(5, 'hot', 'live', c), deterministicTaskId(6, 'hot', 'live', c));
  assert.notEqual(deterministicTaskId(5, 'hot', 'live', c), deterministicTaskId(5, 'hot', 'replay', c));
});

test('dispatch：分成每批最多 10 則送出，回報部分失敗', async () => {
  const batches: ScanTask[][] = [];
  const r = await dispatch({ SCAN_QUEUE_URL: 'q' }, T0, async (_q, tasks) => {
    batches.push(tasks);
    return { failed: batches.length === 2 ? ['0:X:boom'] : [] };
  });
  assert.deepEqual(batches.map((b) => b.length), [10, 4]);
  assert.equal(r.sent, 13);
  assert.equal(r.failed, 1);
});

test('dispatch：沒設 SCAN_QUEUE_URL 直接失敗', async () => {
  await assert.rejects(dispatch({}, T0, async () => ({ failed: [] })), /SCAN_QUEUE_URL/);
});
