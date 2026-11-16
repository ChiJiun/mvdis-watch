# aws/app — dispatcher、worker、notifier、janitor、migration

worker 開發線。介面以 [`../CONTRACTS.md`](../CONTRACTS.md) 為準；這裡只寫契約沒規定、屬於本線的實作細節。

## 指令

| 指令 | 做什麼 |
|---|---|
| `npm run build` | esbuild 打包出 `dist/dispatcher.zip`、`dist/notifier.zip`、`dist/janitor.zip`（內含 `index.mjs`，handler `index.handler`）、`dist/worker.mjs` |
| `npm test` | 單元測試（node:test）。設了 `TEST_DATABASE_URL` 才會跑需要 Postgres 的測試，每個測試檔用一對獨立 schema（取代 `public` 與 `replay`），不動既有資料；migrate 的測試會在該 DB 建出 `replay` schema（若還沒有） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | 把 `../db/schema.pg.sql`（含 `replay` schema）套用到 `DATABASE_URL`，或 `DB_HOST` + `DB_SECRET_ARN` 指定的 RDS。`-- --dry-run` 只印目標與 SQL |
| `npm run e2e:local` | 本機端到端驗證（見下方），跑的是 `dist/` 的打包產物 |
| `npm run worker` | 直接用原始碼跑 worker（開發用） |

Node 22.6 以上（測試與腳本用 `--experimental-strip-types` 直接跑 TypeScript）。

## 本機端到端驗證

```bash
docker compose -p mvdis-worker -f ../docker-compose.yml up -d
npm run build
npm run e2e:local
```

`up` 時 LocalStack 會跑 [`../localstack/init/ready.d`](../localstack/init/ready.d) 建好契約名稱的資源
（`mvdis-scan`＋DLQ、`mvdis-events`、`mvdis-raw-local`、`mvdis/discord`、`mvdis/db`，以及用 notifier filter policy
訂閱的觀察用佇列 `mvdis-notify-local`）。

e2e 腳本自己起假監理站與假 Discord（127.0.0.1），**不會打官網**；為了互不干擾，它另外建一組帶後綴的 queue／topic／bucket。
它會清空本機資料庫的 `public` 四張表與 `replay` 三張表，所以 `DATABASE_URL` 與 `AWS_ENDPOINT_URL` 不是本機位址時會拒絕執行。驗證項目：
init 腳本的資源、dispatcher 每次 14 則、EventBridge 重複觸發不重做、released 寫 DB 與 S3（raw 檔名是 taskId）、
replay 資料只進 `replay` schema、SNS filter policy 只放 live、notifier 把同批事件合併成一則、EMF 指標、DLQ 為空、
§4.2 的 rejected／stale、taskId 不是 UUID 的訊息直接刪、janitor 可執行。

> schema 只有 `CREATE … IF NOT EXISTS`，`npm run migrate` 不會幫既有的表加欄位。本機 schema 變動後要重建 Postgres：
> `docker compose -p mvdis-worker -f ../docker-compose.yml up -d --force-recreate --renew-anon-volumes postgres`

## 設計重點（契約之外，或契約允許多種做法時的選擇）

- **dispatcher 的 taskId 是決定性的**：由（epoch 分鐘, 層, 組合）算 UUIDv5 格式的雜湊。
  EventBridge 同一分鐘重複觸發時，重複的任務在 worker 端被冪等檢查擋掉，不會多打官網。
- **dispatcher 設定不合法時丟例外**（不送任何任務）：`HOT_PER_TICK`／`COLD_PER_TICK` 不是非負整數、或合計不在 1–14。
  讓 Lambda 的 Errors 指標可以設警報。
- **replay 資料隔離（契約 §7.3）**：交易內 `SET LOCAL search_path = <schema>, public`，schema 取自 `DB_SCHEMA_BY_TARGET`；
  交易外的查詢（降頻判斷、補做副作用時重建事件）明確寫 `<schema>.scan_log`／`<schema>.slot_event`。
  schema 對應從 `Deps.schemas` 注入（正式環境就是 `DB_SCHEMA_BY_TARGET`），測試才能每個檔案用自己的一對 schema；
  名稱會直接拼進 SQL，所以只接受小寫識別字（`schemaIdent()`）。
- **舊快照不覆蓋新資料**：持有組合 advisory lock 後，若 `scan_log.last_ok` 比這次抓取時間還新就不套用 diff
  （記 `ok`、error 欄寫 `stale snapshot, not applied`）。這是契約 §5「已知限制」之外多做的保護，
  比較的是各台 worker 的本機時間，依賴 EC2 的 NTP（Amazon Time Sync）；時鐘差幾分鐘時可能誤判成舊快照。
- **同一頁重複的場次鍵**：`parseSlots` 不去重，Postgres 的多列 `INSERT … ON CONFLICT` 遇到重複鍵會報錯，
  所以先以 `(exam_date, sec_key)` 去重、保留最後一筆（和原型 SQLite 逐列覆寫的結果相同）。
- **錯誤分類**：抓取失敗（HTTP 非 200、逾時、解析失敗）只寫 `scan_log.last_error*`、`outcome=error`，提交後
  **照樣刪訊息**，下一輪排程會再抓；這時不寫 raw。DB／S3／SNS 錯誤則不刪訊息，讓 SQS 重送；
  已提交的任務重送時只補做副作用（另一台已做完就回 `duplicate`，不重發 SNS）。格式錯誤的訊息記 log 後直接刪。
- **降頻只套用在 `target = live`**：replay 任務逐筆處理，量測才準。
- **replay 防線有兩道**：`preflight()`（契約 §4.2）與 `resolveTargetUrl()`；replay 請求用 `redirect: 'error'`，
  不會被轉址帶去官網；`REPLAY_BASE_URL` 只接受 http(s)。live 任務只用 `MVDIS_LIVE_URL`，絕不會用到 `REPLAY_BASE_URL`；
  `MVDIS_LIVE_URL` 是 worker 的必填環境變數（沒設就起不來），避免本機忘了設時默默打官網。
- **notifier 同時吃 SNS 與 SQS 事件**：SNS 直接觸發 Lambda 每次只有一筆，無法真的「合併同一批」；
  infra 若改成 SNS → SQS（batching window）→ Lambda，同一批就會合併成一則。

## worker 額外的環境變數（只在本線使用，選填）

| 變數 | 預設 | 說明 |
|---|---|---|
| `FETCH_TIMEOUT_MS` | 20000 | 單次抓取逾時 |
| `WORKER_ID`、`WORKER_AZ` | IMDSv2 | 本機或非 EC2 時手動指定寫進 `scan_task_log` 的 worker 與 AZ |
| `DB_APPLICATION_NAME` | `mvdis-watch` | Postgres `application_name` |
