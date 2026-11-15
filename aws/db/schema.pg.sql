-- AWS 版（RDS PostgreSQL 16）的 schema，從原型的 schema.sql（D1／SQLite）移植。
-- 時間欄位維持 epoch 毫秒（BIGINT），和原型與 aws/shared/contracts.ts 一致。

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
  task_id      UUID,
  run_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_at      ON slot_event (at DESC);
CREATE INDEX IF NOT EXISTS idx_event_kind_at ON slot_event (kind, at DESC);
CREATE INDEX IF NOT EXISTS idx_event_station ON slot_event (dmv_no, at DESC);

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

-- AWS 版新增：每個 SQS 任務一列，用來量測每輪耗時、確認有沒有漏掃，也是 worker 冪等的依據
CREATE TABLE IF NOT EXISTS scan_task_log (
  task_id      UUID    PRIMARY KEY,
  run_id       TEXT,
  license_type TEXT    NOT NULL,
  dmv_no       TEXT    NOT NULL,
  tier         TEXT    NOT NULL,
  target       TEXT    NOT NULL,
  enqueued_at  BIGINT  NOT NULL,
  started_at   BIGINT,
  finished_at  BIGINT,
  outcome      TEXT    CHECK (outcome IN ('ok','error','skipped')),
  error        TEXT,
  worker_id    TEXT,            -- EC2 instance id
  az           TEXT,            -- 可用區域，E2 用來確認故障區的任務被別區接手
  receive_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_task_run ON scan_task_log (run_id, finished_at);
