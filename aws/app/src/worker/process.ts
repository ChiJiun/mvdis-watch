/**
 * 單一 SQS 訊息的處理流程（契約 §4.2、§5）。SQS 是 at-least-once，同一則訊息可能被重送，
 * 甚至被兩台同時處理，所以每一步都以 task_id 為準、可以重做：
 *
 *   1. upsert scan_task_log（receive_count = SQS ApproximateReceiveCount），查 committed_at／finished_at
 *        finished_at 有值            → 已做完，直接刪訊息
 *        committed_at 有值、未 finished → 跳到 5，只補做副作用（不再抓頁面）
 *   2. §4.2 官網保護：live 帶 runId → rejected；live 排隊超過 120 秒 → stale；
 *      replay 而 REPLAY_BASE_URL 未設定或指向官網 → rejected。記錄後刪訊息、不重試
 *   3. 降頻（只套用在 runId = null）：長期沒場次的組合 24 小時內 → skipped
 *   4. 交易外抓頁面、parseSlots；交易內：
 *        FOR UPDATE 鎖 scan_task_log 那一列並重新檢查 committed_at（別台先做完就 rollback、跳到 5）
 *        → pg_advisory_xact_lock 鎖整個組合 → diff → 寫 slot、slot_event、scan_log
 *        → 寫 committed_at、outcome，提交
 *   5. 副作用：事件從 slot_event WHERE task_id 重建；原始 HTML、事件放 S3；released 發 SNS
 *   6. 寫 finished_at，回傳 deleteMessage=true；呼叫端最後才刪訊息
 *
 * 步驟 1 與 2 的順序和契約文件相反：先 upsert 才知道這個任務是不是已經提交過。
 * 已提交、只差副作用的任務不會再發 HTTP 請求，所以不必套 §4.2（否則重送時超過 120 秒，
 * 已寫進 DB 的事件就永遠到不了 S3／SNS）。還沒提交的任務一律先過 §4.2 才可能抓頁面。
 *
 * 失敗分兩種：
 *   - 上游錯誤（HTTP 非 200、逾時、解析失敗）：記 scan_log.last_error 與 outcome=error，照樣刪訊息，
 *     交給下一圈重掃（和原型一樣，不在對方噴錯時加重負擔）。
 *   - 基礎設施錯誤（DB、S3、SNS）：不刪訊息，讓 SQS 重送；已提交的任務重送時只補做副作用。
 *
 * 所有 IO 都從 deps 注入，測試可以換成假的。
 */
import { gzipSync } from 'node:zlib';
import { parseSlots, type Slot } from '../../../../src/mvdis.ts';
import { diffCombo, type SlotRow } from '../../../../src/db.ts';
import {
  s3Keys,
  taipeiIsoDate,
  type ReleasedEvent,
  type ScanTask,
  type SlotEvent,
  type TaskOutcome,
} from '../../../shared/contracts.ts';
import type { Pool, PoolClient } from '../db.ts';
import { withTransaction } from '../db.ts';
import { fetchLocations, preflight, TargetGuardError, type FetchFn, type FetchResult, type Urls } from './fetch.ts';
import type { WorkerIdentity } from './instance.ts';
import { emfLine, type MetricsSink } from './metrics.ts';
import { InvalidTaskError, parseTask } from './task.ts';

/** 連續幾次抓到空結果就降頻（和原型 scan.ts 相同） */
export const PRUNE_AFTER_EMPTY = 5;
export const PRUNE_RECHECK_MS = 24 * 3600 * 1000;

export type Deps = {
  pool: Pool;
  fetchFn: FetchFn;
  putObject: (key: string, body: Uint8Array | string, contentType: string, contentEncoding?: string) => Promise<void>;
  publishReleased: (events: ReleasedEvent[]) => Promise<void>;
  metrics: MetricsSink;
  log: (o: Record<string, unknown>) => void;
  identity: WorkerIdentity;
  urls: Urls;
  fetchTimeoutMs: number;
  now: () => number;
};

export type ProcessResult = {
  deleteMessage: boolean;
  /** TaskOutcome 之外：duplicate＝已做完的重送、resumed＝只補做副作用、invalid＝格式錯誤、retry＝副作用失敗待重送 */
  outcome: TaskOutcome | 'duplicate' | 'resumed' | 'invalid' | 'retry';
  taskId?: string;
  events?: number;
  released?: number;
  error?: string;
};

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

  // === 1. 登記任務 ===
  const state = await upsertTask(deps.pool, task, deps.now(), receiveCount, deps.identity);
  if (state.finished) return { deleteMessage: true, outcome: 'duplicate', taskId: task.taskId };
  if (state.committed) return finishSideEffects(task, null, null, deps, 'resumed');

  // === 2. 官網保護 ===
  const verdict = preflight(task, deps.now(), deps.urls.replayUrl);
  if (verdict) {
    deps.log({ level: 'warn', msg: verdict.outcome, taskId: task.taskId, target: task.target, reason: verdict.reason });
    await finishWithoutScan(deps, task, verdict.outcome, verdict.reason);
    return { deleteMessage: true, outcome: verdict.outcome, taskId: task.taskId, error: verdict.reason };
  }

  // === 3. 降頻（實驗灌入的任務要逐筆處理，量測才準） ===
  if (task.runId === null && (await shouldSkip(deps.pool, task, deps.now()))) {
    await finishWithoutScan(deps, task, 'skipped', null);
    return { deleteMessage: true, outcome: 'skipped', taskId: task.taskId };
  }

  // === 4a. 抓取（交易外，避免長時間持有鎖） ===
  const t0 = deps.now();
  let fetched: FetchResult | null = null;
  let slots: Slot[] | null = null;
  let upstreamError: string | null = null;
  try {
    fetched = await fetchLocations(
      {
        target: task.target,
        urls: deps.urls,
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
      // preflight 已經擋過，走到這裡代表兩道防線判斷不一致；一樣不發請求、記 rejected
      deps.log({ level: 'error', msg: 'target guard', taskId: task.taskId, error: e.message });
      await finishWithoutScan(deps, task, 'rejected', e.message);
      return { deleteMessage: true, outcome: 'rejected', taskId: task.taskId, error: e.message };
    }
    upstreamError = errMsg(e);
  }
  const fetchedAt = deps.now();
  const durationMs = fetchedAt - t0;

  // === 4b. 交易 ===
  const committed = await withTransaction(deps.pool, async (c) => {
    const row = await c.query<{ committed_at: number | null }>(
      'SELECT committed_at FROM scan_task_log WHERE task_id = $1 FOR UPDATE',
      [task.taskId],
    );
    if (row.rows[0]?.committed_at != null) return false; // 別台先提交了
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1 || '|' || $2))", [task.licenseType, task.dmvNo]);

    if (slots === null) {
      await c.query(
        `INSERT INTO scan_log (license_type, dmv_no, last_error, last_error_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (license_type, dmv_no) DO UPDATE SET
           last_error = EXCLUDED.last_error,
           last_error_at = EXCLUDED.last_error_at,
           duration_ms = EXCLUDED.duration_ms`,
        [task.licenseType, task.dmvNo, upstreamError, fetchedAt, durationMs],
      );
      await markCommitted(c, task.taskId, deps.now(), 'error', upstreamError, deps.identity);
    } else {
      const note = await applyScan(c, task, slots, fetchedAt, durationMs);
      await markCommitted(c, task.taskId, deps.now(), 'ok', note, deps.identity);
    }
    return true;
  });

  if (!committed) {
    // 同一個 taskId 被另一台搶先提交；這次抓的結果丟掉，只確保副作用有做
    return finishSideEffects(task, null, null, deps, 'resumed');
  }

  const releasedCount = slots === null ? 0 : await countReleased(deps.pool, task.taskId);
  emitMetrics(deps, task, durationMs, slots === null ? 1 : 0, releasedCount, slots === null ? 'error' : 'ok');

  // === 5、6. 副作用與完成 ===
  return finishSideEffects(task, fetched?.html ?? null, fetchedAt, deps, slots === null ? 'error' : 'ok', upstreamError);
}

/**
 * 補做（或第一次做）副作用，全部成功才寫 finished_at。
 * 失敗時回傳 deleteMessage=false：訊息留著讓 SQS 重送，重送時 committed_at 已有值，只會走到這裡。
 */
async function finishSideEffects(
  task: ScanTask,
  html: string | null,
  fetchedAt: number | null,
  deps: Deps,
  outcome: ProcessResult['outcome'],
  error: string | null = null,
): Promise<ProcessResult> {
  const events = await loadEvents(deps.pool, task.taskId);
  const released: ReleasedEvent[] = events
    .filter((e) => e.kind === 'released')
    .map((e) => ({ ...e, kind: 'released' as const, target: task.target }));

  const side: Array<Promise<unknown>> = [];
  if (html !== null && fetchedAt !== null) {
    side.push(
      deps.putObject(
        s3Keys.raw(taipeiIsoDate(fetchedAt), task.licenseType, task.dmvNo, fetchedAt),
        gzipSync(html),
        'text/html; charset=utf-8',
        'gzip',
      ),
    );
  }
  if (events.length) {
    side.push(
      deps.putObject(
        s3Keys.events(taipeiIsoDate(events[0].at), task.taskId),
        events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        'application/x-ndjson',
      ),
    );
  }
  if (released.length) side.push(deps.publishReleased(released));

  const settled = await Promise.allSettled(side);
  const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => errMsg(s.reason));
  if (failures.length) {
    deps.log({ level: 'error', msg: 'side effect failed, message left for redelivery', taskId: task.taskId, errors: failures });
    return { deleteMessage: false, outcome: 'retry', taskId: task.taskId, events: events.length, error: failures.join('; ') };
  }

  await deps.pool.query('UPDATE scan_task_log SET finished_at = $2 WHERE task_id = $1 AND finished_at IS NULL', [
    task.taskId,
    deps.now(),
  ]);
  return {
    deleteMessage: true,
    outcome,
    taskId: task.taskId,
    events: events.length,
    released: released.length,
    error: error ?? undefined,
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

/** 契約 §5 步驟 2 */
export async function upsertTask(
  pool: Pool,
  task: ScanTask,
  now: number,
  receiveCount: number,
  id: WorkerIdentity,
): Promise<{ committed: boolean; finished: boolean }> {
  const r = await pool.query<{ committed_at: number | null; finished_at: number | null }>(
    `INSERT INTO scan_task_log
       (task_id, run_id, license_type, dmv_no, tier, target, enqueued_at, started_at, worker_id, az, receive_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (task_id) DO UPDATE SET
       receive_count = EXCLUDED.receive_count,
       -- 還沒提交的任務記下這次嘗試的開始時間；已提交的保留原本的
       started_at = CASE WHEN scan_task_log.committed_at IS NULL THEN EXCLUDED.started_at ELSE scan_task_log.started_at END
     RETURNING committed_at, finished_at`,
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
    ],
  );
  const row = r.rows[0];
  return { committed: row.committed_at != null, finished: row.finished_at != null };
}

/** rejected／stale／skipped：沒有抓頁面、沒有交易，直接標記完成 */
async function finishWithoutScan(deps: Deps, task: ScanTask, outcome: TaskOutcome, error: string | null) {
  const now = deps.now();
  await deps.pool.query(
    `UPDATE scan_task_log
        SET outcome = $2, error = $3, finished_at = $4, worker_id = $5, az = $6
      WHERE task_id = $1 AND committed_at IS NULL AND finished_at IS NULL`,
    [task.taskId, outcome, error, now, deps.identity.workerId, deps.identity.az],
  );
}

async function markCommitted(
  c: PoolClient,
  taskId: string,
  now: number,
  outcome: 'ok' | 'error',
  error: string | null,
  id: WorkerIdentity,
) {
  await c.query(
    'UPDATE scan_task_log SET committed_at = $2, outcome = $3, error = $4, worker_id = $5, az = $6 WHERE task_id = $1',
    [taskId, now, outcome, error, id.workerId, id.az],
  );
}

async function shouldSkip(pool: Pool, task: ScanTask, now: number): Promise<boolean> {
  const r = await pool.query<{ skip: number }>(
    `SELECT (empty_streak >= $3 AND last_ok > $4) AS skip
       FROM scan_log WHERE license_type = $1 AND dmv_no = $2`,
    [task.licenseType, task.dmvNo, PRUNE_AFTER_EMPTY, now - PRUNE_RECHECK_MS],
  );
  return r.rows[0]?.skip === 1; // §7.1：bool → 1/0
}

type EventDbRow = {
  license_type: string;
  dmv_no: string;
  exam_date: string;
  sec_key: string;
  kind: SlotEvent['kind'];
  old_quota: number | null;
  new_quota: number | null;
  at: number;
  task_id: string | null;
  run_id: string | null;
};

/** 契約 §5 步驟 5：事件一律從 slot_event 重建，補做時才和第一次完全相同 */
export async function loadEvents(pool: Pool, taskId: string): Promise<SlotEvent[]> {
  const r = await pool.query<EventDbRow>(
    `SELECT license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at, task_id, run_id
       FROM slot_event WHERE task_id = $1 ORDER BY id`,
    [taskId],
  );
  return r.rows.map((e) => ({
    licenseType: e.license_type,
    dmvNo: e.dmv_no,
    examDate: e.exam_date,
    secKey: e.sec_key,
    kind: e.kind,
    oldQuota: e.old_quota,
    newQuota: e.new_quota,
    at: e.at,
    taskId: e.task_id,
    runId: e.run_id,
  }));
}

async function countReleased(pool: Pool, taskId: string): Promise<number> {
  const r = await pool.query<{ n: number }>(
    "SELECT count(*) AS n FROM slot_event WHERE task_id = $1 AND kind = 'released'",
    [taskId],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * 交易內、已持有組合的 advisory lock：diff → 寫 slot、slot_event、scan_log。
 * 回傳要寫進 scan_task_log.error 的備註（正常為 null）。
 */
export async function applyScan(
  c: PoolClient,
  task: ScanTask,
  slots: Slot[],
  fetchedAt: number,
  durationMs: number,
): Promise<string | null> {
  // 比這份快照更新的結果已經寫進去了（兩台處理同一組合、晚抓的先提交）→ 不能用舊資料蓋掉
  const log = await c.query<{ last_ok: number | null }>(
    'SELECT last_ok FROM scan_log WHERE license_type = $1 AND dmv_no = $2',
    [task.licenseType, task.dmvNo],
  );
  const lastOk = log.rows[0]?.last_ok ?? null;
  if (lastOk !== null && lastOk > fetchedAt) return 'stale snapshot, not applied';

  // §7.1 型別規則下 exam_date 是 'yyyy-mm-dd'、旗標是 0/1、epoch 是 Number，直接符合 diffCombo 的 SlotRow
  const existing = await c.query<SlotRow>('SELECT * FROM slot WHERE license_type = $1 AND dmv_no = $2 FOR UPDATE', [
    task.licenseType,
    task.dmvNo,
  ]);
  const d = diffCombo(task.licenseType, task.dmvNo, slots, existing.rows, fetchedAt, taipeiIsoDate(fetchedAt));

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

  if (d.events.length) {
    const ev = d.events;
    await c.query(
      `INSERT INTO slot_event (license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at, task_id, run_id)
       SELECT l, d, e, s, k, o, n, $8::bigint, $9::uuid, $10::text
         FROM unnest($1::text[], $2::text[], $3::date[], $4::text[], $5::text[], $6::int[], $7::int[])
              AS t(l, d, e, s, k, o, n)`,
      [
        ev.map((e) => e.licenseType),
        ev.map((e) => e.dmvNo),
        ev.map((e) => e.examDate),
        ev.map((e) => e.secKey),
        ev.map((e) => e.kind),
        ev.map((e) => e.oldQuota),
        ev.map((e) => e.newQuota),
        fetchedAt,
        task.taskId,
        task.runId,
      ],
    );
  }

  await c.query(
    `INSERT INTO scan_log (license_type, dmv_no, last_ok, rows_seen, empty_streak, duration_ms)
     VALUES ($1, $2, $3, $4, CASE WHEN $4::int = 0 THEN 1 ELSE 0 END, $5)
     ON CONFLICT (license_type, dmv_no) DO UPDATE SET
       last_ok = EXCLUDED.last_ok,
       rows_seen = EXCLUDED.rows_seen,
       empty_streak = CASE WHEN EXCLUDED.rows_seen = 0 THEN scan_log.empty_streak + 1 ELSE 0 END,
       duration_ms = EXCLUDED.duration_ms`,
    [task.licenseType, task.dmvNo, fetchedAt, slots.length, durationMs],
  );
  return null;
}
