/**
 * 單一 SQS 訊息的處理流程（契約第 5 節）：
 *
 *   1. 認領任務：寫 scan_task_log.started_at；已完成的直接刪訊息（冪等）
 *   2. 降頻：長期沒場次的組合 24 小時才查一次，該跳過就記 skipped
 *   3. 抓頁面、parseSlots 解析
 *   4. 單一交易：鎖住該組合 → diff → 寫 slot、slot_event、scan_log、scan_task_log
 *   5. 交易提交後：原始 HTML 與事件放 S3、released 事件發 SNS
 *   6. 回傳 deleteMessage=true，呼叫端最後才刪 SQS 訊息
 *
 * 失敗分兩種：
 *   - 上游錯誤（官網／Replay 回錯、解析失敗、逾時）：記成 scan_log 錯誤與
 *     outcome=error，**照樣刪訊息**。和原型一樣交給下一圈重掃，而不是讓 SQS
 *     在一分鐘後重送 —— 對方已經在噴錯了，重打只會加重它的負擔。
 *   - 基礎設施錯誤（資料庫連不上、交易失敗）：丟例外、不刪訊息，
 *     讓 SQS 重送，三次後進 DLQ。
 *
 * 所有 IO 都從 deps 注入，測試可以換成假的。
 */
import { gzipSync } from 'node:zlib';
import { parseSlots, type Slot } from '../../../../src/mvdis.ts';
import { diffCombo, type SlotRow } from '../../../../src/db.ts';
import {
  s3Keys,
  type ReleasedEvent,
  type ScanTask,
  type SlotEvent,
} from '../../../shared/contracts.ts';
import type { Pool, PoolClient } from '../db.ts';
import { withTransaction } from '../db.ts';
import { fetchLocations, TargetGuardError, type FetchFn, type FetchResult } from './fetch.ts';
import type { WorkerIdentity } from './instance.ts';
import { emfLine, type MetricsSink } from './metrics.ts';
import { InvalidTaskError, parseTask } from './task.ts';

/** 連續幾次抓到空結果就降頻（和原型 scan.ts 相同） */
export const PRUNE_AFTER_EMPTY = 5;
export const PRUNE_RECHECK_MS = 24 * 3600 * 1000;
/**
 * 認領的租約長度。比 SQS 可見性逾時（60 秒）短一點：同一個 taskId 被重複送達、
 * 而另一台還在處理時，這台不會重做；原本那台若當掉，重送時租約已過期，可以接手。
 */
export const CLAIM_LEASE_MS = 55_000;

export type Deps = {
  pool: Pool;
  fetchFn: FetchFn;
  putObject: (key: string, body: Uint8Array | string, contentType: string, contentEncoding?: string) => Promise<void>;
  publishReleased: (events: ReleasedEvent[]) => Promise<void>;
  metrics: MetricsSink;
  log: (o: Record<string, unknown>) => void;
  identity: WorkerIdentity;
  baseUrl: string | undefined;
  fetchTimeoutMs: number;
  now: () => number;
};

export type ProcessResult = {
  deleteMessage: boolean;
  outcome: 'ok' | 'error' | 'skipped' | 'duplicate' | 'in_progress' | 'invalid';
  taskId?: string;
  events?: number;
  released?: number;
  error?: string;
};

/** 台灣日期 yyyy-mm-dd（和原型 scan.ts 的 todayIso 相同） */
export function taiwanDate(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function processMessage(body: string, receiveCount: number, deps: Deps): Promise<ProcessResult> {
  let task: ScanTask;
  try {
    task = parseTask(body);
  } catch (e) {
    if (e instanceof InvalidTaskError) {
      // 不刪：讓它照 maxReceiveCount 進 DLQ，留著給人看
      deps.log({ level: 'error', msg: 'invalid task', error: e.message, body: body.slice(0, 500) });
      return { deleteMessage: false, outcome: 'invalid', error: e.message };
    }
    throw e;
  }

  const startedAt = deps.now();
  const claim = await claimTask(deps.pool, task, startedAt, receiveCount, deps.identity);
  if (claim === 'finished') return { deleteMessage: true, outcome: 'duplicate', taskId: task.taskId };
  if (claim === 'in_progress') {
    // 另一台正在處理同一個 taskId；不刪，可見性逾時後重送時就會看到 finished
    return { deleteMessage: false, outcome: 'in_progress', taskId: task.taskId };
  }

  // 降頻只套用在一般排程（runId = null）；實驗灌入的任務要逐筆處理，量測才準
  if (task.runId === null && (await shouldSkip(deps.pool, task, startedAt))) {
    await finishTask(deps.pool, task.taskId, deps.now(), 'skipped', null);
    return { deleteMessage: true, outcome: 'skipped', taskId: task.taskId };
  }

  // === 抓取 ===
  const t0 = deps.now();
  let fetched: FetchResult | null = null;
  let slots: Slot[] | null = null;
  let upstreamError: string | null = null;
  try {
    fetched = await fetchLocations(
      {
        target: task.target,
        baseUrl: deps.baseUrl,
        licenseType: task.licenseType,
        lv1: task.lv1,
        dmvNo: task.dmvNo,
        now: new Date(t0),
        timeoutMs: deps.fetchTimeoutMs,
      },
      deps.fetchFn,
    );
    if (fetched.status !== 200) throw new Error(`HTTP ${fetched.status}`);
    slots = parseSlots(fetched.html, task.licenseType, task.dmvNo);
  } catch (e) {
    if (e instanceof TargetGuardError) {
      // 設定錯誤，沒有發出任何請求；不碰 scan_log（那是上游健康度）
      deps.log({ level: 'error', msg: 'target guard', taskId: task.taskId, error: e.message });
      await finishTask(deps.pool, task.taskId, deps.now(), 'error', e.message);
      emitMetrics(deps, task, 0, 1, 0, 'error');
      return { deleteMessage: true, outcome: 'error', taskId: task.taskId, error: e.message };
    }
    upstreamError = errMsg(e);
  }
  const fetchedAt = deps.now();
  const durationMs = fetchedAt - t0;

  // === 交易 ===
  let events: SlotEvent[] = [];
  if (slots === null) {
    await withTransaction(deps.pool, async (c) => {
      await c.query(
        `INSERT INTO scan_log (license_type, dmv_no, last_error, last_error_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (license_type, dmv_no) DO UPDATE SET
           last_error = EXCLUDED.last_error,
           last_error_at = EXCLUDED.last_error_at,
           duration_ms = EXCLUDED.duration_ms`,
        [task.licenseType, task.dmvNo, upstreamError, fetchedAt, durationMs],
      );
      await finishTaskWith(c, task.taskId, deps.now(), 'error', upstreamError);
    });
  } else {
    const okSlots = slots;
    events = await withTransaction(deps.pool, (c) => applyScan(c, task, okSlots, fetchedAt, durationMs, deps.now));
  }

  // === 交易提交後的副作用 ===
  const released: ReleasedEvent[] = events
    .filter((e) => e.kind === 'released')
    .map((e) => ({ ...e, kind: 'released' as const, target: task.target }));
  const side: Array<Promise<unknown>> = [];
  if (fetched) {
    side.push(
      deps.putObject(
        s3Keys.raw(taiwanDate(fetchedAt), task.licenseType, task.dmvNo, fetchedAt),
        gzipSync(fetched.html),
        'text/html; charset=utf-8',
        'gzip',
      ),
    );
  }
  if (events.length) {
    side.push(
      deps.putObject(
        s3Keys.events(taiwanDate(fetchedAt), task.taskId),
        events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        'application/x-ndjson',
      ),
    );
  }
  if (released.length) side.push(deps.publishReleased(released));
  const settled = await Promise.allSettled(side);
  const sideErrors = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => errMsg(s.reason));
  if (sideErrors.length) {
    // 交易已提交、scan_task_log 已標記完成，重送也不會重做；只能記下來
    deps.log({ level: 'error', msg: 'post-commit side effect failed', taskId: task.taskId, errors: sideErrors });
  }

  const outcome = slots === null ? 'error' : 'ok';
  emitMetrics(deps, task, durationMs, slots === null ? 1 : 0, released.length, outcome);
  return {
    deleteMessage: true,
    outcome,
    taskId: task.taskId,
    events: events.length,
    released: released.length,
    error: upstreamError ?? undefined,
  };
}

function emitMetrics(deps: Deps, task: ScanTask, durationMs: number, errors: number, released: number, outcome: string) {
  deps.metrics(
    emfLine(
      { Tier: task.tier, Target: task.target },
      { ScanDurationMs: durationMs, ScanErrors: errors, ReleasedEvents: released },
      {
        taskId: task.taskId,
        runId: task.runId,
        licenseType: task.licenseType,
        dmvNo: task.dmvNo,
        outcome,
        workerId: deps.identity.workerId,
        az: deps.identity.az,
      },
      deps.now(),
    ),
  );
}

/**
 * 認領任務。用 ON CONFLICT 的 WHERE 一次判斷完：
 *   - 新任務 → 插入，回 claimed
 *   - 已完成（finished_at 有值）→ finished
 *   - 另一台租約還沒過期 → in_progress
 */
export async function claimTask(
  pool: Pool,
  task: ScanTask,
  now: number,
  receiveCount: number,
  id: WorkerIdentity,
): Promise<'claimed' | 'finished' | 'in_progress'> {
  const r = await pool.query(
    `INSERT INTO scan_task_log
       (task_id, run_id, license_type, dmv_no, tier, target, enqueued_at, started_at, worker_id, az, receive_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (task_id) DO UPDATE SET
       started_at = EXCLUDED.started_at,
       worker_id = EXCLUDED.worker_id,
       az = EXCLUDED.az,
       receive_count = GREATEST(scan_task_log.receive_count + 1, EXCLUDED.receive_count)
     WHERE scan_task_log.finished_at IS NULL
       AND (scan_task_log.started_at IS NULL OR scan_task_log.started_at < $12)
     RETURNING task_id`,
    [
      task.taskId,
      task.runId,
      task.licenseType,
      task.dmvNo,
      task.tier,
      task.target,
      task.enqueuedAt,
      now,
      id.workerId,
      id.az,
      Math.max(1, receiveCount),
      now - CLAIM_LEASE_MS,
    ],
  );
  if (r.rowCount) return 'claimed';
  const s = await pool.query<{ finished: boolean }>(
    'SELECT finished_at IS NOT NULL AS finished FROM scan_task_log WHERE task_id = $1',
    [task.taskId],
  );
  return s.rows[0]?.finished ? 'finished' : 'in_progress';
}

async function shouldSkip(pool: Pool, task: ScanTask, now: number): Promise<boolean> {
  const r = await pool.query<{ skip: boolean }>(
    `SELECT (empty_streak >= $3 AND last_ok > $4) AS skip
       FROM scan_log WHERE license_type = $1 AND dmv_no = $2`,
    [task.licenseType, task.dmvNo, PRUNE_AFTER_EMPTY, now - PRUNE_RECHECK_MS],
  );
  return r.rows[0]?.skip === true;
}

async function finishTask(pool: Pool, taskId: string, now: number, outcome: 'ok' | 'error' | 'skipped', error: string | null) {
  await pool.query('UPDATE scan_task_log SET finished_at = $2, outcome = $3, error = $4 WHERE task_id = $1', [
    taskId,
    now,
    outcome,
    error,
  ]);
}

async function finishTaskWith(c: PoolClient, taskId: string, now: number, outcome: 'ok' | 'error', error: string | null) {
  await c.query('UPDATE scan_task_log SET finished_at = $2, outcome = $3, error = $4 WHERE task_id = $1', [
    taskId,
    now,
    outcome,
    error,
  ]);
}

/**
 * 交易內：鎖住組合 → diff → 寫入。回傳寫進 slot_event 的事件。
 *
 * 鎖的順序：先鎖 scan_log 那一列當作「這個組合的互斥鎖」，再 SELECT … FOR UPDATE 鎖 slot。
 * 只鎖 slot 不夠 —— 組合第一次被掃時還沒有任何 slot 列，兩台同時處理會各自插入、
 * 各記一次 new 事件。
 */
export async function applyScan(
  c: PoolClient,
  task: ScanTask,
  slots: Slot[],
  fetchedAt: number,
  durationMs: number,
  now: () => number,
): Promise<SlotEvent[]> {
  await c.query('INSERT INTO scan_log (license_type, dmv_no) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    task.licenseType,
    task.dmvNo,
  ]);
  const lock = await c.query<{ last_ok: number | null }>(
    'SELECT last_ok::float8 AS last_ok FROM scan_log WHERE license_type = $1 AND dmv_no = $2 FOR UPDATE',
    [task.licenseType, task.dmvNo],
  );
  const existing = await c.query<SlotRow>(
    `SELECT license_type, dmv_no, to_char(exam_date, 'YYYY-MM-DD') AS exam_date, sec_key, quota,
            CASE WHEN signup_available THEN 1 ELSE 0 END AS signup_available,
            sec_desc, session, grp, weekday,
            CASE WHEN is_weekend THEN 1 ELSE 0 END AS is_weekend,
            first_seen::float8 AS first_seen, updated_at::float8 AS updated_at
       FROM slot WHERE license_type = $1 AND dmv_no = $2
       FOR UPDATE`,
    [task.licenseType, task.dmvNo],
  );

  // 比這份快照更新的結果已經寫進去了（兩台處理同一組合、晚抓的先提交）→ 不能用舊資料蓋掉
  const lastOk = lock.rows[0]?.last_ok ?? null;
  if (lastOk !== null && lastOk > fetchedAt) {
    await finishTaskWith(c, task.taskId, now(), 'ok', 'stale snapshot, not applied');
    return [];
  }

  const d = diffCombo(task.licenseType, task.dmvNo, slots, existing.rows, fetchedAt, taiwanDate(fetchedAt));

  if (d.upserts.length) {
    const cols = 14;
    const values: string[] = [];
    const params: unknown[] = [];
    d.upserts.forEach((s, i) => {
      const b = i * cols;
      values.push(`(${Array.from({ length: cols }, (_, k) => `$${b + k + 1}`).join(',')})`);
      params.push(
        s.licenseType,
        s.dmvNo,
        s.examDate,
        s.secKey,
        s.quota,
        s.signupAvailable,
        s.desc,
        s.session,
        s.group,
        s.weekday,
        s.isWeekend,
        d.firstSeen.get(`${s.examDate}|${s.secKey}`) ?? fetchedAt,
        fetchedAt,
        fetchedAt,
      );
    });
    await c.query(
      `INSERT INTO slot (license_type, dmv_no, exam_date, sec_key, quota, signup_available,
                         sec_desc, session, grp, weekday, is_weekend, first_seen, updated_at, seen_at)
       VALUES ${values.join(',')}
       ON CONFLICT (license_type, dmv_no, exam_date, sec_key) DO UPDATE SET
         quota = EXCLUDED.quota,
         signup_available = EXCLUDED.signup_available,
         sec_desc = EXCLUDED.sec_desc,
         updated_at = EXCLUDED.updated_at,
         seen_at = EXCLUDED.seen_at`,
      params,
    );
  }

  if (d.deletes.length) {
    await c.query(
      `DELETE FROM slot
        WHERE license_type = $1 AND dmv_no = $2
          AND (exam_date, sec_key) IN (SELECT * FROM unnest($3::date[], $4::text[]))`,
      [task.licenseType, task.dmvNo, d.deletes.map((x) => x.examDate), d.deletes.map((x) => x.secKey)],
    );
  }

  const events: SlotEvent[] = d.events.map((e) => ({
    licenseType: e.licenseType,
    dmvNo: e.dmvNo,
    examDate: e.examDate,
    secKey: e.secKey,
    kind: e.kind,
    oldQuota: e.oldQuota,
    newQuota: e.newQuota,
    at: fetchedAt,
    taskId: task.taskId,
    runId: task.runId,
  }));

  if (events.length) {
    await c.query(
      `INSERT INTO slot_event (license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at, task_id, run_id)
       SELECT * FROM unnest($1::text[], $2::text[], $3::date[], $4::text[], $5::text[],
                            $6::int[], $7::int[], $8::bigint[], $9::uuid[], $10::text[])`,
      [
        events.map((e) => e.licenseType),
        events.map((e) => e.dmvNo),
        events.map((e) => e.examDate),
        events.map((e) => e.secKey),
        events.map((e) => e.kind),
        events.map((e) => e.oldQuota),
        events.map((e) => e.newQuota),
        events.map((e) => e.at),
        events.map((e) => e.taskId),
        events.map((e) => e.runId),
      ],
    );
  }

  await c.query(
    `UPDATE scan_log SET
       last_ok = $3,
       rows_seen = $4,
       empty_streak = CASE WHEN $4::int = 0 THEN empty_streak + 1 ELSE 0 END,
       duration_ms = $5
     WHERE license_type = $1 AND dmv_no = $2`,
    [task.licenseType, task.dmvNo, fetchedAt, slots.length, durationMs],
  );

  await finishTaskWith(c, task.taskId, now(), 'ok', null);
  return events;
}
