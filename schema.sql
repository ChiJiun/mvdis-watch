-- 目前狀態。只在餘額變動時才 upsert，因此每日寫入量遠低於 D1 免費額度。
CREATE TABLE IF NOT EXISTS slot (
  license_type TEXT NOT NULL,
  dmv_no       TEXT NOT NULL,
  exam_date    TEXT NOT NULL,           -- ISO yyyy-mm-dd
  sec_key      TEXT NOT NULL,           -- 從場次說明推導，額滿/有位兩種狀態都一致
  quota        INTEGER NOT NULL,        -- -1 = 額滿
  signup_available INTEGER NOT NULL DEFAULT 0,
  sec_desc     TEXT,
  session      TEXT,
  grp          INTEGER,
  weekday      TEXT,
  is_weekend   INTEGER NOT NULL DEFAULT 0,
  first_seen   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  seen_at      INTEGER NOT NULL,        -- 最後一次在官網上看到（即使沒變動也更新）
  PRIMARY KEY (license_type, dmv_no, exam_date, sec_key)
);

-- 首頁「現在有位」用；只索引有餘額的列，索引很小
CREATE INDEX IF NOT EXISTS idx_slot_available
  ON slot (quota DESC, exam_date) WHERE quota > 0;

CREATE INDEX IF NOT EXISTS idx_slot_combo ON slot (license_type, dmv_no, exam_date);

-- 變化事件流：退考釋位就是從這裡冒出來的
CREATE TABLE IF NOT EXISTS slot_event (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  license_type TEXT NOT NULL,
  dmv_no       TEXT NOT NULL,
  exam_date    TEXT NOT NULL,
  sec_key      TEXT NOT NULL,
  kind         TEXT NOT NULL,  -- released | increased | decreased | filled | new | gone
  old_quota    INTEGER,
  new_quota    INTEGER,
  at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_at ON slot_event (at DESC);
CREATE INDEX IF NOT EXISTS idx_event_kind_at ON slot_event (kind, at DESC);

-- 分片游標等排程狀態
CREATE TABLE IF NOT EXISTS scan_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 通知訂閱。target 是 Discord webhook URL —— 它等同密鑰，任何人拿到就能
-- 往你的頻道發訊息，所以 /api/subscriptions 全系列端點都要 ADMIN_TOKEN。
CREATE TABLE IF NOT EXISTS subscription (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL DEFAULT 'discord',
  target       TEXT NOT NULL,
  label        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  last_sent_at INTEGER,
  last_error   TEXT
);

-- 這個訂閱要盯哪些「監理站 × 照類」。空的代表全部。
CREATE TABLE IF NOT EXISTS subscription_watch (
  subscription_id INTEGER NOT NULL,
  license_type    TEXT NOT NULL,
  dmv_no          TEXT NOT NULL,
  PRIMARY KEY (subscription_id, license_type, dmv_no)
);

-- 每個組合的掃描健康度。empty_streak 用來跳過長期沒開場次的組合
-- （實測 360 組中有 153 組永遠是空的，例如恆春分站不考聯結車）。
CREATE TABLE IF NOT EXISTS scan_log (
  license_type TEXT NOT NULL,
  dmv_no       TEXT NOT NULL,
  last_ok      INTEGER,
  last_error   TEXT,
  last_error_at INTEGER,
  rows_seen    INTEGER NOT NULL DEFAULT 0,
  empty_streak INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  PRIMARY KEY (license_type, dmv_no)
);

-- 每站公開頁面：一次撈該站全部照類的場次（含額滿），以及該站的事件流
CREATE INDEX IF NOT EXISTS idx_slot_station ON slot (dmv_no, exam_date);
CREATE INDEX IF NOT EXISTS idx_event_station ON slot_event (dmv_no, at DESC);
