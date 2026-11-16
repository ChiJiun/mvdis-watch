/**
 * 單一 SQS 訊息的處理流程（契約 §4.2、§4.4、§5、§7.3）。SQS 是 at-least-once，同一則訊息可能被重送，
 * 甚至被兩台同時處理，所以每一步都以 task_id 為準、可以重做：
 *
 *   1. 解析訊息：格式錯誤（JSON、v、taskId 不是 UUID、欄位不合 catalogue）→ 記 log 後直接刪
 *   2. upsert scan_task_log（receive_count = SQS ApproximateReceiveCount），查 committed_at／finished_at
 *        finished_at 有值            → 已做完，直接刪訊息
 *        committed_at 有值、未 finished → 跳到 7，只補做副作用（不再抓頁面，不受 §4.2 的 120 秒限制）
 *   3. §4.2 官網保護：live 帶 runId → rejected；live 排隊超過 120 秒 → stale；
 *      replay 而 REPLAY_BASE_URL 未設定或指向官網 → rejected；
 *      replay 而 replay schema 缺表（to_regclass 檢查）→ rejected（search_path 是 fail-open，缺表會靜默寫進 public）
 *   4. §4.4 降頻（只有 live）：長期沒場次的組合 24 小時內 → skipped
 *      （3、4 都以 UPDATE … WHERE committed_at IS NULL 記錄後刪訊息、不重試；
 *       UPDATE 影響 0 列表示別台剛提交，改成補做副作用，不直接刪）
 *   5. 交易外抓頁面、parseSlots
 *   6. 交易：set_config('search_path', '<target 的 schema>, public', true)（replay 寫進 replay schema）
 *        → FOR UPDATE 鎖 scan_task_log 那一列並重新檢查：committed_at 有值（別台先做完）→ rollback、跳到 7；
 *          finished_at 有值但未提交（別台已判 rejected／stale／skipped）→ rollback、刪訊息
 *        → pg_advisory_xact_lock(hashtext(target|license|dmv)) 鎖整個組合
 *        → 成功：diff → 寫 slot、slot_event、scan_log，outcome=ok
 *          失敗（HTTP 非 200、逾時、解析失敗）：只寫 scan_log.last_error*，outcome=error
 *        → 寫 committed_at、outcome，提交
 *   7. 副作用（所有查詢都明確帶 schema，不依賴連線的 search_path）：
 *      事件從 <schema>.slot_event WHERE task_id 重建；dt = taipeiIsoDate(committed_at)；
 *      原始 HTML（只有 ok）與事件放 S3；released 發 SNS
 *   8. 寫 finished_at，回傳 deleteMessage=true；呼叫端最後才刪訊息
 *
 * 抓取失敗不靠 SQS 重試（提交後照樣刪訊息），下一輪排程會再抓。
 * 基礎設施錯誤（DB、S3、SNS）才不刪訊息，讓 SQS 重送；已提交的任務重送時只補做副作用。
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
import type { DbSchemas, Pool, PoolClient } from '../db.ts';
import { missingReplayTables, schemaFor, schemaIdent, withTransaction } from '../db.ts';
import { fetchLocations, preflight, TargetGuardError, type FetchFn, type FetchResult, type Urls } from './fetch.ts';
import type { WorkerIdentity } from './instance.ts';
import { emfLine, type MetricsSink } from './metrics.ts';
import { InvalidTaskError, parseTask } from './task.ts';

/** 連續幾次抓到空結果就降頻（和原型 scan.ts 相同） */
export const PRUNE_AFTER_EMPTY = 5;
export const PRUNE_RECHECK_MS = 24 * 3600 * 1000;

export type Deps = {
  pool: Pool;
  /** 各 target 的資料 schema（契約 §7.3）；正式環境是 DEFAULT_SCHEMAS */
  schemas: DbSchemas;
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

/** 這個任務的 slot／slot_event／scan_log 在哪個 schema */
/** 這個任務的 slot／slot_event／scan_log 在哪個 schema；未知 target 丟例外，絕不插值成 undefined */
const dataSchema = (deps: Deps, task: ScanTask) => schemaFor(deps.schemas, task.target);
/** scan_task_log 所在的 schema（正式環境是 public） */
const taskSchema = (deps: Deps) => schemaFor(deps.schemas, 'live');

export async function processMessage(body: string, receiveCount: number, deps: Deps): Promise<ProcessResult> {
  // === 1. 解析 ===
  let task: ScanTask;
  try {
    task = parseTask(body);
  } catch (e) {
    if (e instanceof InvalidTaskError) {
      // 契約 §5 步驟 1：不寫 DB、直接刪（留著只會一直重試到進 DLQ）
      deps.log({ level: 'error', msg: 'invalid task, deleted', error: e.message, body: body.slice(0, 500) });
      return { deleteMessage: true, outcome: 'invalid', error: e.message };
    }
    throw e;
  }

  // === 2. 登記任務、冪等判斷 ===
  const state = await upsertTask(deps.pool, task, deps.now(), receiveCount, deps.identity, taskSchema(deps));
  if (state.finished) return { deleteMessage: true, outcome: 'duplicate', taskId: task.taskId };
  if (state.committed) return finishSideEffects(task, null, deps, 'resumed');

  // === 3. 官網保護 ===
  let verdict = preflight(task, deps.now(), deps.urls.replayUrl);
  if (!verdict && task.target === 'replay') {
    // R3-1：replay schema 缺表時 search_path 會落到 public，所以缺任何一張就拒絕（fail-closed）
    const missing = await missingReplayTables(deps.pool, dataSchema(deps, task));
    if (missing.length) verdict = { outcome: 'rejected', reason: `replay schema 缺表：${missing.join(', ')}，拒絕 replay 任務` };
  }
  if (verdict) {
    deps.log({ level: 'warn', msg: verdict.outcome, taskId: task.taskId, target: task.target, reason: verdict.reason });
    return finishWithoutScan(deps, task, verdict.outcome, verdict.reason);
  }

  // === 4. 降頻（只有 live；replay 實驗量測的是每一則任務） ===
  if (task.target === 'live' && (await shouldSkip(deps, task, deps.now()))) {
    return finishWithoutScan(deps, task, 'skipped', null);
  }

  // === 5. 抓取（交易外，避免長時間持有鎖） ===
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
    slots = dedupeSlots(parseSlots(fetched.html, task.licenseType, task.dmvNo));
  } catch (e) {
    if (e instanceof TargetGuardError) {
      // preflight 已經擋過，走到這裡代表兩道防線判斷不一致；一樣不發請求、記 rejected
      deps.log({ level: 'error', msg: 'target guard', taskId: task.taskId, error: e.message });
      return finishWithoutScan(deps, task, 'rejected', e.message);
    }
    upstreamError = errMsg(e);
  }
  const fetchedAt = deps.now();
  const durationMs = fetchedAt - t0;

  // === 6. 交易 ===
  const schema = dataSchema(deps, task);
  const ts = taskSchema(deps);
  const txResult = await withTransaction(deps.pool, async (c): Promise<'committed' | 'already-committed' | 'already-finished'> => {
    // 契約 §7.3：slot／slot_event／scan_log 寫不帶 schema 的表名，replay 的落在 replay schema。
    // 用 set_config 帶參數（SET 不能用 bind 參數）；兩個名稱都已經過 schemaIdent，只會是小寫識別字。
    // scan_task_log 一律明確寫 schema，不靠 search_path。
    await c.query("SELECT set_config('search_path', $1, true)", [`${schema}, ${ts}`]);
    const row = await c.query<{ committed_at: number | null; finished_at: number | null }>(
      `SELECT committed_at, finished_at FROM ${ts}.scan_task_log WHERE task_id = $1 FOR UPDATE`,
      [task.taskId],
    );
    if (row.rows[0]?.committed_at != null) return 'already-committed'; // 別台先提交了
    // R3-2：別台已經把它判成 rejected／stale／skipped（finished 而未 committed），不能再提交成 ok
    if (row.rows[0]?.finished_at != null) return 'already-finished';
    // R3-4：鎖的鍵帶 target，live 與 replay 寫不同的表，不必互相等
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1 || '|' || $2 || '|' || $3))", [
      task.target,
      task.licenseType,
      task.dmvNo,
    ]);

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
      await markCommitted(c, ts, task.taskId, deps.now(), 'error', upstreamError, deps.identity);
    } else {
      const note = await applyScan(c, task, slots, fetchedAt, durationMs);
      await markCommitted(c, ts, task.taskId, deps.now(), 'ok', note, deps.identity);
    }
    return 'committed';
  });

  if (txResult === 'already-committed') {
    // 同一個 taskId 被另一台搶先提交；這次抓的結果丟掉，只確保副作用有做
    return finishSideEffects(task, null, deps, 'resumed');
  }
  if (txResult === 'already-finished') {
    deps.log({ level: 'warn', msg: 'task already finished by another worker, result discarded', taskId: task.taskId });
    return { deleteMessage: true, outcome: 'duplicate', taskId: task.taskId };
  }

  const releasedCount = slots === null ? 0 : await countReleased(deps, task);
  emitMetrics(deps, task, durationMs, slots === null ? 1 : 0, releasedCount, slots === null ? 'error' : 'ok');

  // === 7、8. 副作用與完成（outcome=error 時不寫 raw） ===
  return finishSideEffects(task, slots === null ? null : fetched!.html, deps, slots === null ? 'error' : 'ok', upstreamError);
}

/**
 * 同一頁出現重複的 (exam_date, sec_key) 時保留最後一筆（和原型 SQLite 逐列覆寫的結果一樣）。
 * 不去重的話，多列 INSERT … ON CONFLICT 會報「cannot affect row a second time」，訊息變成毒訊息。
 */
export function dedupeSlots(slots: Slot[]): Slot[] {
  const byKey = new Map<string, Slot>();
  for (const s of slots) {
    const k = `${s.examDate}|${s.secKey}`;
    byKey.delete(k); // 重新插入，讓順序跟著最後一筆
    byKey.set(k, s);
  }
  return byKey.size === slots.length ? slots : [...byKey.values()];
}

/**
 * 補做（或第一次做）副作用，全部成功才寫 finished_at。
 * 失敗時回傳 deleteMessage=false：訊息留著讓 SQS 重送，重送時 committed_at 已有值，只會走到這裡。
 * html 只在這次抓取成功（outcome=ok）時傳入；補做時已沒有 HTML，raw 略過。
 */
async function finishSideEffects(
  task: ScanTask,
  html: string | null,
  deps: Deps,
  outcome: ProcessResult['outcome'],
  error: string | null = null,
): Promise<ProcessResult> {
  const ts = taskSchema(deps);
  const tl = await deps.pool.query<{ committed_at: number | null; finished_at: number | null }>(
    `SELECT committed_at, finished_at FROM ${ts}.scan_task_log WHERE task_id = $1`,
    [task.taskId],
  );
  const row = tl.rows[0];
  // 另一台已經把副作用做完（兩台同時處理同一個 taskId），不要再發一次 SNS
  if (row?.finished_at != null) return { deleteMessage: true, outcome: 'duplicate', taskId: task.taskId };
  if (row?.committed_at == null) throw new Error(`task ${task.taskId} 尚未提交，不能做副作用`);
  // 契約 §5 步驟 7：dt 一律用 committed_at，補做時也是同一個值，物件鍵不會變
  const dt = taipeiIsoDate(row.committed_at);

  const events = await loadEvents(deps.pool, task.taskId, dataSchema(deps, task));
  const released: ReleasedEvent[] = events
    .filter((e) => e.kind === 'released')
    .map((e) => ({ ...e, kind: 'released' as const, target: task.target }));

  const side: Array<Promise<unknown>> = [];
  if (html !== null) {
    side.push(
      deps.putObject(s3Keys.raw(dt, task.licenseType, task.dmvNo, task.taskId), gzipSync(html), 'text/html; charset=utf-8', 'gzip'),
    );
  }
  if (events.length) {
    side.push(
      deps.putObject(
        s3Keys.events(dt, task.taskId),
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

  await deps.pool.query(`UPDATE ${ts}.scan_task_log SET finished_at = $2 WHERE task_id = $1 AND finished_at IS NULL`, [
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
  schema = 'public',
): Promise<{ committed: boolean; finished: boolean }> {
  const ts = schemaIdent(schema);
  const r = await pool.query<{ committed_at: number | null; finished_at: number | null }>(
    `INSERT INTO ${ts}.scan_task_log
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

/**
 * rejected／stale／skipped：沒有抓頁面、沒有交易，直接標記完成（契約 §4.2 的記法）。
 * UPDATE 影響 0 列（R3-2）代表在步驟 2 之後別台剛好提交了：這時不能直接刪訊息，
 * 否則對方若在副作用途中掛掉，SNS／S3 就永遠補不回來 → 改成補做副作用。
 */
async function finishWithoutScan(
  deps: Deps,
  task: ScanTask,
  outcome: 'rejected' | 'stale' | 'skipped',
  error: string | null,
): Promise<ProcessResult> {
  const ts = taskSchema(deps);
  const r = await deps.pool.query(
    `UPDATE ${ts}.scan_task_log
        SET outcome = $2, error = $3, finished_at = $4, worker_id = $5, az = $6
      WHERE task_id = $1 AND committed_at IS NULL`,
    [task.taskId, outcome, error, deps.now(), deps.identity.workerId, deps.identity.az],
  );
  if ((r.rowCount ?? 0) > 0) return { deleteMessage: true, outcome, taskId: task.taskId, error: error ?? undefined };

  const row = (
    await deps.pool.query<{ committed_at: number | null }>(`SELECT committed_at FROM ${ts}.scan_task_log WHERE task_id = $1`, [
      task.taskId,
    ])
  ).rows[0];
  if (row?.committed_at != null) {
    deps.log({ level: 'warn', msg: `${outcome} skipped: committed by another worker, resuming side effects`, taskId: task.taskId });
    return finishSideEffects(task, null, deps, 'resumed');
  }
  // 那一列不見了（例如被 janitor 刪掉）：沒有東西要補，照原判定刪訊息
  return { deleteMessage: true, outcome, taskId: task.taskId, error: error ?? undefined };
}

async function markCommitted(
  c: PoolClient,
  ts: string,
  taskId: string,
  now: number,
  outcome: 'ok' | 'error',
  error: string | null,
  id: WorkerIdentity,
) {
  await c.query(
    `UPDATE ${ts}.scan_task_log SET committed_at = $2, outcome = $3, error = $4, worker_id = $5, az = $6 WHERE task_id = $1`,
    [taskId, now, outcome, error, id.workerId, id.az],
  );
}

async function shouldSkip(deps: Deps, task: ScanTask, now: number): Promise<boolean> {
  const r = await deps.pool.query<{ skip: number }>(
    `SELECT (empty_streak >= $3 AND last_ok > $4) AS skip
       FROM ${dataSchema(deps, task)}.scan_log WHERE license_type = $1 AND dmv_no = $2`,
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

/** 契約 §5 步驟 7：事件一律從 <schema>.slot_event 重建，補做時才和第一次完全相同 */
export async function loadEvents(pool: Pool, taskId: string, schema: string): Promise<SlotEvent[]> {
  const r = await pool.query<EventDbRow>(
    `SELECT license_type, dmv_no, exam_date, sec_key, kind, old_quota, new_quota, at, task_id, run_id
       FROM ${schemaIdent(schema)}.slot_event WHERE task_id = $1 ORDER BY id`,
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

async function countReleased(deps: Deps, task: ScanTask): Promise<number> {
  const r = await deps.pool.query<{ n: number }>(
    `SELECT count(*) AS n FROM ${dataSchema(deps, task)}.slot_event WHERE task_id = $1 AND kind = 'released'`,
    [task.taskId],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * 交易內、已設好 search_path 並持有組合的 advisory lock：diff → 寫 slot、slot_event、scan_log。
 * 回傳要寫進 scan_task_log.error 的備註（正常為 null）。
 */
export async function applyScan(
  c: PoolClient,
  task: ScanTask,
  slots: Slot[],
  fetchedAt: number,
  durationMs: number,
): Promise<string | null> {
  // 比這份快照更新的結果已經寫進去了（兩台處理同一組合、晚抓的先提交）→ 不能用舊資料蓋掉。
  // 比的是各台 worker 的本機時間，依賴 EC2 的 NTP（Amazon Time Sync）；見 README。
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
