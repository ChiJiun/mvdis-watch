# aws/app — dispatcher、worker、notifier、migration

worker 開發線。介面以 [`../CONTRACTS.md`](../CONTRACTS.md) 為準；這裡只寫契約沒規定、屬於本線的實作細節。

## 指令

| 指令 | 做什麼 |
|---|---|
| `npm run build` | esbuild 打包出 `dist/dispatcher.zip`、`dist/notifier.zip`（內含 `index.mjs`，handler `index.handler`）、`dist/worker.mjs` |
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

腳本自己起假監理站與假 Discord（127.0.0.1），**不會打官網**；它會清空本機資料庫的四張表，
所以 `DATABASE_URL` 與 `AWS_ENDPOINT_URL` 不是本機位址時會拒絕執行。驗證項目：
dispatcher 每次 14 則、EventBridge 重複觸發不重做、released 寫 DB 與 S3、SNS filter policy
只放 live、notifier 把同批事件合併成一則、EMF 指標、DLQ 為空。

## 設計重點（契約之外的決定）

- **dispatcher 的 taskId 是決定性的**：由（epoch 分鐘, 層, 目標, 組合）算 UUIDv5 格式的雜湊。
  EventBridge 同一分鐘重複觸發時，重複的任務在 worker 端被冪等檢查擋掉，不會多打官網。
- **live 上限**：`HOT_PER_TICK + COLD_PER_TICK > 14` 時先砍冷門再砍熱門並記 warning；
  `SCAN_TARGET` 不是 `live`／`replay` 時當作 `live`。`planTick` 最後再截一次。
- **認領租約**：`scan_task_log.started_at` 當作 55 秒租約（比可見性逾時 60 秒短）。
  同一個 taskId 另一台還在處理時不重做、不刪訊息；原處理者當掉時重送可接手。
- **每組合互斥**：交易先鎖 `scan_log` 那一列，再 `SELECT … FOR UPDATE` 鎖 `slot`。
  組合第一次被掃時還沒有 slot 列，只鎖 slot 擋不住兩台同時插入。
- **舊快照不覆蓋新資料**：`scan_log.last_ok` 比這次抓取時間還新時不套用 diff（記 `ok`、error 欄寫 `stale snapshot`）。
- **錯誤分類**：上游錯誤（HTTP 非 200、逾時、解析失敗）記 `scan_log.last_error` 與 `outcome=error`，
  **照樣刪訊息**，交給下一圈重掃（和原型一樣，不在對方噴錯時加重負擔）。
  資料庫等基礎設施錯誤則不刪訊息，讓 SQS 重送、三次後進 DLQ。格式錯誤的訊息也不刪，直接留給 DLQ。
- **降頻只套用在 `runId = null`**：實驗灌入的任務逐筆處理，量測才準。
- **replay 防線**：`target=replay` 時 `MVDIS_BASE_URL` 必須明確設定且不是 `*.mvdis.gov.tw`，
  否則一個請求都不發、任務記 `error`；replay 請求用 `redirect: 'error'`，不會被轉址帶去官網。
- **S3 的 `dt=` 分區用台灣日期**（和原型 `todayIso` 一致）。
- **notifier 同時吃 SNS 與 SQS 事件**：SNS 直接觸發 Lambda 每次只有一筆，無法真的「合併同一批」；
  infra 若改成 SNS → SQS（batching window）→ Lambda，同一批就會合併成一則。

## worker 額外的環境變數（只在本線使用，選填）

| 變數 | 預設 | 說明 |
|---|---|---|
| `FETCH_TIMEOUT_MS` | 20000 | 單次抓取逾時 |
| `WORKER_ID`、`WORKER_AZ` | IMDSv2 | 本機或非 EC2 時手動指定寫進 `scan_task_log` 的 worker 與 AZ |
| `DB_APPLICATION_NAME` | `mvdis-watch` | Postgres `application_name` |
