# aws/app — dispatcher、worker、notifier、janitor、migration

worker 開發線。介面以 [`../CONTRACTS.md`](../CONTRACTS.md) 為準；這裡只寫契約沒規定、屬於本線的實作細節。

## 指令

| 指令 | 做什麼 |
|---|---|
| `npm run build` | esbuild 打包出 `dist/dispatcher.zip`、`dist/notifier.zip`、`dist/janitor.zip`（內含 `index.mjs`，handler `index.handler`）、`dist/worker.mjs` |
| `npm test` | 單元測試（node:test）。設了 `TEST_DATABASE_URL` 才會跑需要 Postgres 的測試，每個測試檔用獨立 schema，不動既有資料 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | 把 `../db/schema.pg.sql` 套用到 `DATABASE_URL`，或 `DB_HOST` + `DB_SECRET_ARN` 指定的 RDS。`-- --dry-run` 只印目標與 SQL |
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
它會清空本機資料庫的四張表，所以 `DATABASE_URL` 與 `AWS_ENDPOINT_URL` 不是本機位址時會拒絕執行。驗證項目：
init 腳本的資源、dispatcher 每次 14 則、EventBridge 重複觸發不重做、released 寫 DB 與 S3、SNS filter policy
只放 live、notifier 把同批事件合併成一則、EMF 指標、DLQ 為空、§4.2 的 rejected／stale、janitor 可執行。

> schema 只有 `CREATE … IF NOT EXISTS`，`npm run migrate` 不會幫既有的表加欄位。本機 schema 變動後要重建 Postgres：
> `docker compose -p mvdis-worker -f ../docker-compose.yml up -d --force-recreate --renew-anon-volumes postgres`

## 設計重點（契約之外，或契約允許多種做法時的選擇）

- **dispatcher 的 taskId 是決定性的**：由（epoch 分鐘, 層, 組合）算 UUIDv5 格式的雜湊。
  EventBridge 同一分鐘重複觸發時，重複的任務在 worker 端被冪等檢查擋掉，不會多打官網。
- **dispatcher 設定超過 14 則時丟例外**（不送任何任務），讓 Lambda 的 Errors 指標可以設警報。
- **處理順序**：契約 §5 寫「先 §4.2、再 upsert」，實作是先 upsert 再 §4.2。已提交、只差副作用的任務
  不會再發 HTTP 請求，因此直接補做副作用，不套 120 秒規則 —— 否則重送時已超過 120 秒，
  DB 裡的事件就永遠到不了 S3／SNS。還沒提交的任務一律先過 §4.2 才可能抓頁面。
- **舊快照不覆蓋新資料**：持有組合 advisory lock 後，若 `scan_log.last_ok` 比這次抓取時間還新就不套用 diff
  （記 `ok`、error 欄寫 `stale snapshot, not applied`）。
- **錯誤分類**：上游錯誤（HTTP 非 200、逾時、解析失敗）記 `scan_log.last_error` 與 `outcome=error`，
  **照樣刪訊息**，交給下一圈重掃（和原型一樣，不在對方噴錯時加重負擔）。
  DB／S3／SNS 錯誤則不刪訊息，讓 SQS 重送；已提交的任務重送時只補做副作用。格式錯誤的訊息也不刪，留給 DLQ。
- **降頻只套用在 `runId = null`**：實驗灌入的任務逐筆處理，量測才準。
- **replay 防線有兩道**：`preflight()`（契約 §4.2）與 `resolveTargetUrl()`；replay 請求用 `redirect: 'error'`，
  不會被轉址帶去官網。live 任務只用 `MVDIS_LIVE_URL`（未設定時預設官網），絕不會用到 `REPLAY_BASE_URL`。
- **notifier 同時吃 SNS 與 SQS 事件**：SNS 直接觸發 Lambda 每次只有一筆，無法真的「合併同一批」；
  infra 若改成 SNS → SQS（batching window）→ Lambda，同一批就會合併成一則。

## worker 額外的環境變數（只在本線使用，選填）

| 變數 | 預設 | 說明 |
|---|---|---|
| `FETCH_TIMEOUT_MS` | 20000 | 單次抓取逾時 |
| `WORKER_ID`、`WORKER_AZ` | IMDSv2 | 本機或非 EC2 時手動指定寫進 `scan_task_log` 的 worker 與 AZ |
| `DB_APPLICATION_NAME` | `mvdis-watch` | Postgres `application_name` |
