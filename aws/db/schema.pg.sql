-- AWS 版（RDS PostgreSQL 16）的 schema，從原型的 schema.sql（D1／SQLite）移植。
-- 時間欄位維持 epoch 毫秒（BIGINT），和原型與 aws/shared/contracts.ts 一致。
-- DATE／BIGINT／BOOLEAN 讀出時一律依 CONTRACTS.md §7.1 轉換（date→字串、bigint→Number、bool→0/1）。
--
-- public schema 只放正式（target=live）資料；replay 實驗的 slot／slot_event／scan_log 放在檔案最後的
-- replay schema（同結構），scan_task_log 兩者共用（CONTRACTS.md §7.3）。

CREATE TABLE IF NOT EXISTS slot (
  license_type     TEXT    NOT NULL,
  dmv_no           TEXT    NOT NULL,
  exam_date        DATE    NOT NULL,
  sec_key          TEXT    NOT NULL,
  quota            INTEGER NOT NULL,          -- -1 = 額滿
  signup_available BOOLEAN NOT NULL DEFAULT FALSE,
  sec_desc         TEXT,
  session          TEXT,
  grp              INTEGER,
  weekday          TEXT,
  is_weekend       BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen       BIGINT  NOT NULL,
  updated_at       BIGINT  NOT NULL,
  seen_at          BIGINT  NOT NULL,
  PRIMARY KEY (license_type, dmv_no, exam_date, sec_key)
);

CREATE INDEX IF NOT EXISTS idx_slot_available ON slot (quota DESC, exam_date) WHERE quota > 0;
CREATE INDEX IF NOT EXISTS idx_slot_station   ON slot (dmv_no, exam_date);

CREATE TABLE IF NOT EXISTS slot_event (
  id           BIGSERIAL PRIMARY KEY,
  license_type TEXT   NOT NULL,
  dmv_no       TEXT   NOT NULL,
  exam_date    DATE   NOT NULL,
  sec_key      TEXT   NOT NULL,
  kind         TEXT   NOT NULL CHECK (kind IN ('released','increased','decreased','filled','new','gone')),
  old_quota    INTEGER,
  new_quota    INTEGER,
  at           BIGINT NOT NULL,
  task_id      UUID,            -- AWS 版產生的事件一定有；從原型匯入的歷史事件為 NULL
  run_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_at      ON slot_event (at DESC);
CREATE INDEX IF NOT EXISTS idx_event_kind_at ON slot_event (kind, at DESC);
CREATE INDEX IF NOT EXISTS idx_event_station ON slot_event (dmv_no, at DESC);
CREATE INDEX IF NOT EXISTS idx_event_task    ON slot_event (task_id);

CREATE TABLE IF NOT EXISTS scan_log (
  license_type  TEXT    NOT NULL,
  dmv_no        TEXT    NOT NULL,
  last_ok       BIGINT,
  last_error    TEXT,
  last_error_at BIGINT,
  rows_seen     INTEGER NOT NULL DEFAULT 0,
  empty_streak  INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  PRIMARY KEY (license_type, dmv_no)
);

-- AWS 版新增：每個 SQS 任務一列，用來量測每輪耗時、確認有沒有漏掃，也是 worker 冪等的依據（CONTRACTS.md §5）
CREATE TABLE IF NOT EXISTS scan_task_log (
  task_id       UUID    PRIMARY KEY,
  run_id        TEXT,
  license_type  TEXT    NOT NULL,
  dmv_no        TEXT    NOT NULL,
  tier          TEXT    NOT NULL CHECK (tier IN ('hot','cold')),
  target        TEXT    NOT NULL CHECK (target IN ('live','replay')),
  enqueued_at   BIGINT  NOT NULL,
  started_at    BIGINT,
  committed_at  BIGINT,           -- DB 交易提交的時間
  finished_at   BIGINT,           -- S3／SNS 副作用都完成的時間；有值才算這個任務做完
  outcome       TEXT    CHECK (outcome IN ('ok','error','skipped','stale','rejected')),
  error         TEXT,
  worker_id     TEXT,             -- EC2 instance id
  az            TEXT,             -- 可用區域，E2 用來確認故障區的任務被別區接手
  receive_count INTEGER NOT NULL DEFAULT 1  -- 取自 SQS ApproximateReceiveCount
);

CREATE INDEX IF NOT EXISTS idx_task_run      ON scan_task_log (run_id, finished_at);
CREATE INDEX IF NOT EXISTS idx_task_finished ON scan_task_log (finished_at);

-- ---------------------------------------------------------------------------
-- replay schema：target=replay 任務的資料，和正式資料完全隔開（CONTRACTS.md §7.3）。
-- 結構和 public 的同名表相同；worker 處理 replay 任務時在交易內 SET LOCAL search_path = replay, public。
-- 不用 CREATE TABLE … (LIKE …)，因為 BIGSERIAL 會共用 public 的 sequence，TRUNCATE … RESTART IDENTITY 會互相影響。
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS replay;

CREATE TABLE IF NOT EXISTS replay.slot (
  license_type     TEXT    NOT NULL,
  dmv_no           TEXT    NOT NULL,
  exam_date        DATE    NOT NULL,
  sec_key          TEXT    NOT NULL,
  quota            INTEGER NOT NULL,
  signup_available BOOLEAN NOT NULL DEFAULT FALSE,
  sec_desc         TEXT,
  session          TEXT,
  grp              INTEGER,
  weekday          TEXT,
  is_weekend       BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen       BIGINT  NOT NULL,
  updated_at       BIGINT  NOT NULL,
  seen_at          BIGINT  NOT NULL,
  PRIMARY KEY (license_type, dmv_no, exam_date, sec_key)
);

CREATE INDEX IF NOT EXISTS idx_slot_available ON replay.slot (quota DESC, exam_date) WHERE quota > 0;
CREATE INDEX IF NOT EXISTS idx_slot_station   ON replay.slot (dmv_no, exam_date);

CREATE TABLE IF NOT EXISTS replay.slot_event (
  id           BIGSERIAL PRIMARY KEY,
  license_type TEXT   NOT NULL,
  dmv_no       TEXT   NOT NULL,
  exam_date    DATE   NOT NULL,
  sec_key      TEXT   NOT NULL,
  kind         TEXT   NOT NULL CHECK (kind IN ('released','increased','decreased','filled','new','gone')),
  old_quota    INTEGER,
  new_quota    INTEGER,
  at           BIGINT NOT NULL,
  task_id      UUID,
  run_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_at      ON replay.slot_event (at DESC);
CREATE INDEX IF NOT EXISTS idx_event_kind_at ON replay.slot_event (kind, at DESC);
CREATE INDEX IF NOT EXISTS idx_event_station ON replay.slot_event (dmv_no, at DESC);
CREATE INDEX IF NOT EXISTS idx_event_task    ON replay.slot_event (task_id);
CREATE INDEX IF NOT EXISTS idx_event_run     ON replay.slot_event (run_id, at);

CREATE TABLE IF NOT EXISTS replay.scan_log (
  license_type  TEXT    NOT NULL,
  dmv_no        TEXT    NOT NULL,
  last_ok       BIGINT,
  last_error    TEXT,
  last_error_at BIGINT,
  rows_seen     INTEGER NOT NULL DEFAULT 0,
  empty_streak  INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  PRIMARY KEY (license_type, dmv_no)
);
