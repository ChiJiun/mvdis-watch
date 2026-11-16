# AWS 版介面契約

四條開發線（infra／worker／api／replay＋experiments）**只透過這份文件約定的介面互相依賴**。
要改這裡的任何東西，先在 PR 描述寫清楚，並同步更新 `aws/shared/contracts.ts`。

## 1. 目錄與擁有者

| 目錄 | 擁有者（開發線） | 內容 |
|---|---|---|
| `aws/infra/` | infra | Terraform：VPC、SG、ALB、ASG、RDS、SQS、Lambda、S3、Athena、SNS、CloudFront、CloudWatch |
| `aws/app/` | worker | 分派器 Lambda、爬蟲 worker、推播 Lambda、每日清理、資料庫 migration 腳本 |
| `aws/localstack/` | worker | LocalStack 啟動時建立 queue／topic／bucket／secret 的腳本（`init/ready.d/*.sh`） |
| `aws/api/` | api | 公開 API 服務（EC2 ASG 上跑）＋儀表板靜態頁 |
| `aws/replay/` | replay | Replay 模擬站與 fixture 擷取腳本 |
| `aws/experiments/` | replay | E1–E4 實驗腳本（Locust、故障注入、計時、成本計算） |
| `aws/shared/`、`aws/db/`、`aws/docker-compose.yml`、本文件 | 共用（改動要在 PR 說明） | 型別、Postgres schema、本機環境、本契約 |

- 根目錄 `src/` 是 Cloudflare 原型，**不要改**。AWS 版可以直接 import `src/mvdis.ts`（`parseSlots` 等純函式；`querySlots` 寫死官網網址，不要用）、`src/catalogue.ts`。
- 每條線各自有 `package.json`，不要共用 `node_modules`、不要改根目錄的 `package.json`。

## 2. 執行環境

- Node.js 22（AWS Lambda `nodejs22.x`、EC2 用 Amazon Linux 2023 的 `nodejs22`）。
- TypeScript 原始碼，用 **esbuild** 打包成單一 ESM 檔：
  - Lambda：`aws/<線>/dist/<name>.zip`（內含 `index.mjs`，handler 為 `index.handler`）。
  - EC2 服務：`aws/<線>/dist/<name>.mjs`，由 infra 上傳到 `s3://<artifact_bucket>/releases/<name>.mjs`，user data 下載後以 systemd 執行。
- 打包產物名稱固定如下，infra 依這些名稱部署：

| 名稱 | 類型 | 產出位置 | 觸發 |
|---|---|---|---|
| `dispatcher` | Lambda zip | `aws/app/dist/dispatcher.zip` | EventBridge 每分鐘 |
| `notifier` | Lambda zip | `aws/app/dist/notifier.zip` | SNS `mvdis-events` |
| `janitor` | Lambda zip | `aws/app/dist/janitor.zip` | EventBridge 每日一次（台灣時間 04:00）；需要 DB，放 VPC private 應用層、套 Worker-SG |
| `worker` | EC2 mjs | `aws/app/dist/worker.mjs` | systemd |
| `api` | EC2 mjs | `aws/api/dist/api.mjs` | systemd |
| `replay` | EC2 mjs | `aws/replay/dist/replay.mjs` | systemd |

## 3. 環境變數

所有服務都只從環境變數讀設定。本機開發時用 `aws/docker-compose.yml` 的 Postgres 與 LocalStack。

| 變數 | 用在 | 說明 |
|---|---|---|
| `AWS_REGION` | 全部 | 預設 `us-east-1`（Learner Lab） |
| `AWS_ENDPOINT_URL` | 全部（僅本機） | 指向 LocalStack `http://localhost:4566` |
| `DATABASE_URL` | worker、janitor、api（本機） | 有值時優先使用，例如 `postgres://mvdis:mvdis@localhost:5432/mvdis` |
| `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_SECRET_ARN` | worker、janitor、api（AWS） | 密碼存 Secrets Manager，secret 內容為 JSON `{"username":"…","password":"…"}` |
| `SCAN_QUEUE_URL` | dispatcher、worker | SQS 掃描佇列 |
| `EVENT_TOPIC_ARN` | worker | SNS 釋位事件 topic |
| `RAW_BUCKET` | worker | S3 資料湖 bucket |
| `MVDIS_LIVE_URL` | worker | 官網 origin，固定 `https://www.mvdis.gov.tw`，只用於 `target=live` 任務 |
| `REPLAY_BASE_URL` | worker | Replay 模擬站 origin，例如 `http://10.0.11.20:8080`，只用於 `target=replay` 任務；未設定時 worker 拒絕所有 replay 任務 |
| `HOT_PER_TICK`、`COLD_PER_TICK` | dispatcher | 預設 11、3；必須是非負整數且合計 1–14，否則 dispatcher **拒絕執行**（記錯誤、不送任何任務） |
| `DISCORD_SECRET_ARN` | notifier | secret 內容為 JSON `{"webhookUrl":"https://discord.com/api/webhooks/…"}` |
| `PORT` | api、replay | 預設 8080 |
| `WORKER_CONCURRENCY` | worker | 單台同時處理幾則訊息，預設 5 |

## 4. SQS 掃描任務（dispatcher／實驗腳本 → worker）

- 佇列：`mvdis-scan`，可見性逾時 60 秒，訊息保留 1 小時，`maxReceiveCount = 3` 後進 `mvdis-scan-dlq`。
- 訊息 body 為 JSON，型別見 `aws/shared/contracts.ts` 的 `ScanTask`：

```json
{ "v": 1, "taskId": "uuid", "licenseType": "3", "lv1": "60", "dmvNo": "63",
  "tier": "hot", "target": "live", "runId": null, "enqueuedAt": 1794761624526 }
```

### 4.1 dispatcher 的分段（無狀態、可重現）

dispatcher 不連資料庫、不放 VPC。設 `m = floor(Date.now() / 60000)`，`HOT = hotCombos()`（108 組）、`COLD = coldCombos()`（252 組），順序以 `src/catalogue.ts` 為準：

```
hotStart  = (m * HOT_PER_TICK)  mod HOT.length    → 取 HOT[hotStart …] 共 HOT_PER_TICK 組（超過尾端就繞回開頭）
coldStart = (m * COLD_PER_TICK) mod COLD.length   → 取 COLD[coldStart …] 共 COLD_PER_TICK 組
```

dispatcher 送出的任務一律 `target = "live"`、`runId = null`。
EventBridge 也是至少一次觸發，極少數情況同一分鐘會呼叫兩次，所以「每分鐘最多 14 則」指的是正常情況；這種重複觸發可以接受，不另外去重。

### 4.2 禮貌原則（官網保護，worker 必須自己再檢查一次）

worker 在 §5 步驟 3（冪等判斷之後）、發出任何 HTTP 請求前，依序檢查：

1. `target = "live"` 且 `runId != null` → `rejected`（實驗腳本不得送 live 任務）。
2. `target = "live"` 且 `now - enqueuedAt > 120 秒` → `stale`，丟棄不抓（避免 Learner Lab 停機期間積壓的任務在恢復後一次打向官網）。
3. `target = "replay"` 且 `REPLAY_BASE_URL` 未設定、或其主機名稱是 `mvdis.gov.tw` 或其子網域 → `rejected`。
4. 網址：`live` 用 `MVDIS_LIVE_URL`、`replay` 用 `REPLAY_BASE_URL`，再接上 `MVDIS_PATH`。

`rejected`／`stale` 都以 `UPDATE scan_task_log SET outcome = …, finished_at = now WHERE task_id = $1 AND committed_at IS NULL` 記錄（那一列在 §5 步驟 2 已建立），然後刪除訊息、不重試。
已經提交過（`committed_at` 有值）的任務不會走到這裡，所以補做副作用不受 120 秒限制。

原型送官網的 HTTP 標頭（`User-Agent`、`Referer`、`Accept-Language`）live 任務照樣帶；Replay 站不檢查標頭。

### 4.3 官網查詢表單

POST `application/x-www-form-urlencoded`，欄位與原型 `src/mvdis.ts` 的 `querySlots` 相同（見 `contracts.ts` 的 `mvdisFormFields`）：
`method=query`、`licenseTypeCode`、`expectExamDateStr`（民國 yyyMMdd）、`_onlyWeekend=on`、`dmvNoLv1`、`dmvNo`、`secDateStr=`、`secId=`、`divId=`，只查週末時另加 `onlyWeekend=true`。Replay 站必須接受同一組欄位。

### 4.4 降頻

長期沒場次的組合（`scan_log.empty_streak >= 5`）24 小時才查一次，由 worker 判斷：上次 `last_ok` 在 24 小時內就記 `skipped` 並刪訊息（記法同 §4.2）。被降頻的組合仍會占用該分鐘的名額，因此熱門層一輪約 10 分鐘、冷門層實際約 84 分鐘（原型會跳過並改抓下一組，AWS 版不會）。

降頻只套用在 `target = "live"`；replay 任務一律照抓，實驗量測的是每一則任務。

## 5. worker 的處理流程與冪等性

SQS 是 at-least-once：同一則訊息可能被重送，甚至被兩台 worker 同時處理。流程如下：

1. 解析訊息：JSON 格式錯誤、`v` 不符，或 `taskId` 不是 UUID → 記 log 後直接刪訊息（不寫 DB；寫了也會因 UUID 型別報錯，訊息只會一直重試到進 DLQ）。
2. `INSERT INTO scan_task_log … ON CONFLICT (task_id) DO UPDATE SET receive_count = <SQS ApproximateReceiveCount>`；查出 `committed_at`、`finished_at`：
   - `finished_at` 有值 → 直接刪訊息，結束。
   - `committed_at` 有值但 `finished_at` 為空 → 跳到步驟 7（只補做副作用）。
3. 依 §4.2 檢查，不通過就記錄並刪訊息。
4. 依 §4.4 判斷降頻（只有 live），要略過就記 `skipped` 並刪訊息。
5. 抓頁面並用 `parseSlots` 解析（在交易外做，避免長時間持有鎖）。
6. 單一交易：
   1. `SET LOCAL search_path = <DB_SCHEMA_BY_TARGET[target]>, public`（§7.3：replay 的資料寫進 `replay` schema）。
   2. `SELECT … FROM scan_task_log WHERE task_id = $1 FOR UPDATE`；若 `committed_at` 已有值（別台先做完）→ rollback，跳到步驟 7。
   3. `SELECT pg_advisory_xact_lock(hashtext(license_type || '|' || dmv_no))`，鎖住整個組合（即使它還沒有任何 slot 列）。
   4. 抓取成功：讀既有 slot 列 → 比對差異 → 寫 `slot`、`slot_event`（帶 `task_id`、`run_id`）、`scan_log`（`last_ok`、`rows_seen`、`empty_streak`、`duration_ms`），`outcome = ok`。
      抓取或解析失敗：不動 `slot`／`slot_event`，只寫 `scan_log.last_error`、`last_error_at`，`outcome = error`、`error` 記錯誤訊息。失敗不靠 SQS 重試，下一輪排程會再抓（live 約 10 分鐘後）。
   5. 更新 `scan_task_log.committed_at`、`outcome`、`worker_id`、`az`，提交。
7. 副作用（都以 `task_id` 為準，重做只會覆寫同一個物件；SNS 例外，可能重複一次）。`dt = taipeiIsoDate(committed_at)`，補做時也用同一個值：
   - 事件從 `SELECT … FROM <schema>.slot_event WHERE task_id = $1` 重建（schema 依 target）。
   - 原始 HTML（gzip）放 `s3://$RAW_BUCKET/` + `s3Keys.raw(dt, licenseType, dmvNo, taskId)`；補做時若已沒有 HTML 可略過。`outcome = error` 時不寫。
   - 事件放 `s3Keys.events(dt, taskId)`（每行一個 `SlotEvent`，沒有事件就不寫）。
   - `kind = released` 的事件逐筆發到 SNS。
8. 寫 `scan_task_log.finished_at`，最後刪 SQS 訊息。

`dt` 分區一律用**台灣時間（Asia/Taipei）**的日期，和原型的 `todayIso` 一致。
worker 若重用 `src/db.ts` 的 `diffCombo`，傳入的 DB 列必須符合 §7.1 的型別，`exam_date` 是 `yyyy-mm-dd` 字串、旗標是 0/1。

已知限制（不處理）：同一組合的兩個不同任務若亂序提交（較早抓的較晚提交），會覆蓋較新的狀態並產生一對來回的事件。live 每組約 10 分鐘才一次，幾乎不會發生；實驗對同組合大量灌任務時，E3 的分析要考慮這點。

## 6. SNS 釋位事件（worker → notifier）

- Topic：`mvdis-events`，訊息 body 為 `ReleasedEvent`（見 `aws/shared/contracts.ts`），at-least-once，notifier 不保證去重。
- 訊息屬性：`target`，DataType `String`，值為 `live` 或 `replay`。
- notifier 的訂閱 filter policy 固定為 `{"target":["live"]}`。
- 實驗不會洗版 Discord 靠兩層：filter policy 擋掉 replay 事件；§7.3 讓 replay 不碰正式的 `slot`，live 掃描不會拿 replay 寫入的狀態比對而產生假的 `released`。

## 7. 資料庫

- RDS PostgreSQL 16，schema 見 `aws/db/schema.pg.sql`。由 worker 線的 migration 腳本（`aws/app` 的 `npm run migrate`）套用；本機的 docker compose 啟動時也會自動套用。
- 除了原型的表，另加 `scan_task_log`，給實驗量測「每輪耗時」與「有沒有漏掃」，也是 worker 冪等的依據。原型的 `scan_state` 與 `subscription*` 不移植。
- 每日清理由 worker 線的 `janitor` 負責：刪除 30 天前的 `slot_event`、考試日已過的 `slot`（「今天」用台灣日期，同原型 `todayIso`）、30 天前的 `scan_task_log`。`public` 與 `replay` 兩個 schema 都要清。

### 7.1 型別對應（所有連 DB 的服務都必須一致）

node-postgres 的預設轉換會讓回應和原型不同，所以**所有服務都要套用 `contracts.ts` 的 `PG_TYPE_RULES`**：

| Postgres 型別（OID） | JS 值 | 理由 |
|---|---|---|
| `date`（1082） | 原字串 `yyyy-mm-dd` | 預設會轉成 `Date`，序列化後格式不同，非 UTC 時區還會差一天 |
| `int8`／`bigint`（20） | `Number` | epoch ms 與 `COUNT()` 都在安全整數範圍內；預設會變成字串 |
| `numeric`（1700） | `Number` | `SUM()` 的結果 |
| `bool`（16） | `1`／`0` | 原型（SQLite）的旗標是 0/1，前端與 `diffCombo` 都依賴這個格式 |

這張表只管「讀出」。寫 SQL 時，BOOLEAN 欄位不能和整數字面值比較：原型的 `is_weekend = 1` 在 Postgres 會報錯 `operator does not exist: boolean = integer`。請寫 `TRUE`／`FALSE`，或用參數（`is_weekend = $1` 傳 1／0 可以）。

### 7.2 `lastTick`

原型 `/api/meta`、`/api/station` 回傳的 `lastTick`，AWS 版定義為：

```sql
SELECT GREATEST(MAX(last_ok), MAX(last_error_at)) AS last_tick FROM public.scan_log
```

### 7.3 replay 資料隔離

replay 任務抓的是模擬站，資料不能進正式的表，否則公開 API 會顯示實驗資料、`lastTick` 會被實驗推進，而且實驗後的 live 掃描會拿模擬站的狀態比對，產生假的 `released` 推到 Discord。

| 表 | `target = live` | `target = replay` |
|---|---|---|
| `slot`、`slot_event`、`scan_log` | `public` schema | `replay` schema（同結構，見 `schema.pg.sql` 後段） |
| `scan_task_log` | `public`（共用，用 `target`、`run_id` 區分） | 同左 |

- worker：交易內 `SET LOCAL search_path = <schema>, public`，schema 取自 `contracts.ts` 的 `DB_SCHEMA_BY_TARGET`。SQL 寫不帶 schema 的表名即可，兩種任務共用同一份程式。
- api：只讀 `public`，不需要過濾；不得讀 `replay` schema。
- experiments：事件與狀態讀 `replay.slot_event`、`replay.slot`、`replay.scan_log`，任務量測讀 `public.scan_task_log WHERE target = 'replay'`。每次實驗前可以 `TRUNCATE replay.slot, replay.slot_event, replay.scan_log`（由實驗腳本或 replay 的 `/admin/reset` 前後執行，擁有者為 replay 線）。
- S3：replay 任務仍寫 `raw/`、`events/`，以 `events` 每一行的 `runId` 區分；Athena 分析正式資料時加 `WHERE runId IS NULL`。

## 8. HTTP 介面

| 服務 | Port | 路徑 |
|---|---|---|
| api | 8080 | `GET /healthz`、`GET /api/meta`、`/api/available`、`/api/overview`、`/api/events`、`/api/slots`、`/api/station`（參數與回應格式和原型 `src/index.ts` 相同）；`GET /` 儀表板 |
| replay | 8080 | `GET /healthz`；`POST /m3-emv-trn/exm/locations`（表單欄位見 §4.3，回傳同格式 HTML）；`POST /admin/reset` |

- api 的回應要帶 `Cache-Control: public, max-age=30`，讓 CloudFront 快取 30 秒。
- ALB 健康檢查打 `/healthz`，回 200 即健康。

## 9. CloudWatch 指標

- Namespace `MvdisWatch`，worker 用 Embedded Metric Format 寫 log：
  - `ScanDurationMs`、`ScanErrors`、`ReleasedEvents`，維度 `Tier`、`Target`。
- worker ASG 依 `ApproximateNumberOfMessagesVisible / InService 台數` 做 target tracking（目標值由 infra 決定）。

## 10. Learner Lab 限制（infra 與所有人都要遵守）

- 不能建 IAM role：EC2 用 `LabInstanceProfile`，Lambda 用 `LabRole`（Terraform 以 data source 取得 ARN）。
- 憑證約 4 小時過期、session 結束 EC2 會停（EventBridge 與 dispatcher 仍會繼續送任務，靠 §4.2 的 stale 規則與 1 小時訊息保留擋住積壓）：所有資源都要能 `terraform destroy` 後重建；資料庫內容不是唯一來源（原始資料在 S3、長期蒐集靠 Cloudflare 版）。
- RDS Multi-AZ、Secrets Manager、CloudFront 在 Learner Lab 是否可用尚未實測，infra 線部署前要先確認。
