import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLD,
  HOT,
  DispatchConfigError,
  deterministicTaskId,
  dispatchConfig,
  epochMinute,
  planTick,
  segment,
} from '../src/dispatcher/plan.ts';
import { dispatch } from '../src/dispatcher/index.ts';
import type { ScanTask } from '../../shared/contracts.ts';

const key = (t: { licenseType: string; dmvNo: string }) => `${t.licenseType}|${t.dmvNo}`;
const T0 = Date.UTC(2026, 10, 16, 0, 0, 0);

test('熱門／冷門組合數與原型一致', () => {
  assert.equal(HOT.length, 108);
  assert.equal(COLD.length, 252);
});

test('連續 10 分鐘輪完全部 108 個熱門組合；連續 84 分鐘輪完 252 個冷門組合', () => {
  const config = dispatchConfig({});
  const hot = new Set<string>();
  const cold = new Set<string>();
  for (let i = 0; i < 84; i++) {
    for (const t of planTick(T0 + i * 60_000, config)) (t.tier === 'hot' ? hot : cold).add(key(t));
    if (i === 9) assert.equal(hot.size, 108, '10 分鐘內熱門要全部輪到');
  }
  assert.equal(cold.size, 252, '84 分鐘內冷門要全部輪到');
});

test('分段是無狀態的：同一分鐘內任何時間點算出來都一樣，連續分鐘首尾相接', () => {
  const config = dispatchConfig({});
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
  const config = dispatchConfig({});
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

test('live 上限：合計超過 14 時拒絕執行（丟 DispatchConfigError），不自動調整', () => {
  for (const env of [
    { HOT_PER_TICK: '12', COLD_PER_TICK: '3' },
    { HOT_PER_TICK: '15', COLD_PER_TICK: '0' },
    { COLD_PER_TICK: '4' }, // 預設 11 + 4
    { HOT_PER_TICK: '1000' },
  ]) {
    assert.throws(() => dispatchConfig(env), DispatchConfigError, JSON.stringify(env));
  }
  assert.deepEqual(dispatchConfig({ HOT_PER_TICK: '14', COLD_PER_TICK: '0' }), { hotPerTick: 14, coldPerTick: 0 });
  assert.deepEqual(dispatchConfig({ HOT_PER_TICK: '-5', COLD_PER_TICK: 'abc' }), { hotPerTick: 11, coldPerTick: 3 }, '壞值退回預設');
});

test('planTick 的最後防線：就算 config 被繞過，也絕不送出超過 14 則', () => {
  assert.throws(() => planTick(T0, { hotPerTick: 100, coldPerTick: 100 }), DispatchConfigError);
});

test('分段公式與契約 §4.1 一致：hotStart = (m*HOT_PER_TICK) mod 108', () => {
  const m = epochMinute(T0);
  const tasks = planTick(T0, { hotPerTick: 11, coldPerTick: 3 });
  assert.equal(key(tasks[0]), key(HOT[(m * 11) % 108]));
  assert.equal(key(tasks[11]), key(COLD[(m * 3) % 252]));
  assert.ok(tasks.every((t) => t.target === 'live' && t.runId === null));
});

test('taskId 由（分鐘, 層, 組合）決定：EventBridge 重複觸發會得到相同 taskId', () => {
  const c = HOT[0];
  assert.equal(deterministicTaskId(5, 'hot', c), deterministicTaskId(5, 'hot', c));
  assert.notEqual(deterministicTaskId(5, 'hot', c), deterministicTaskId(6, 'hot', c));
  assert.notEqual(deterministicTaskId(5, 'hot', c), deterministicTaskId(5, 'cold', c));
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

test('dispatch：設定超過上限時一則都不送', async () => {
  let calls = 0;
  await assert.rejects(
    dispatch({ SCAN_QUEUE_URL: 'q', HOT_PER_TICK: '20' }, T0, async () => {
      calls++;
      return { failed: [] };
    }),
    DispatchConfigError,
  );
  assert.equal(calls, 0);
});

test('dispatch：沒設 SCAN_QUEUE_URL 直接失敗', async () => {
  await assert.rejects(dispatch({}, T0, async () => ({ failed: [] })), /SCAN_QUEUE_URL/);
});
