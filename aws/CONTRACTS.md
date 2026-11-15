# AWS 版介面契約

四條開發線（infra／worker／api／replay＋experiments）**只透過這份文件約定的介面互相依賴**。
要改這裡的任何東西，先在 PR 描述寫清楚，並同步更新 `aws/shared/contracts.ts`。

## 1. 目錄與擁有者

| 目錄 | 擁有者（開發線） | 內容 |
|---|---|---|
| `aws/infra/` | infra | Terraform：VPC、SG、ALB、ASG、RDS、SQS、Lambda、S3、Athena、SNS、CloudFront、CloudWatch |
| `aws/app/` | worker | 分派器 Lambda、爬蟲 worker、推播 Lambda、資料庫 migration 腳本 |
| `aws/api/` | api | 公開 API 服務（EC2 ASG 上跑）＋儀表板靜態頁 |
| `aws/replay/` | replay | Replay 模擬站與 fixture 擷取腳本 |
| `aws/experiments/` | replay | E1–E4 實驗腳本（Locust、故障注入、計時、成本計算） |
| `aws/shared/`、`aws/db/`、本文件 | 共用（改動要在 PR 說明） | 型別、Postgres schema、本契約 |

- 根目錄 `src/` 是 Cloudflare 原型，**不要改**。AWS 版可以直接 import `src/mvdis.ts`、`src/catalogue.ts` 的純函式。
- 每條線各自有 `package.json`，不要共用 `node_modules`、不要改根目錄的 `package.json`。

## 2. 執行環境

- Node.js 22（AWS Lambda `nodejs22.x`、EC2 用 Amazon Linux 2023 的 `nodejs22`）。
- TypeScript 原始碼，用 **esbuild** 打包成單一 ESM 檔：
  - Lambda：`aws/<線>/dist/<name>.zip`（內含 `index.mjs`，handler 為 `index.handler`）。
  - EC2 服務：`aws/<線>/dist/<name>.mjs`，由 infra 上傳到 `s3://<artifact_bucket>/releases/<name>.mjs`，user data 下載後以 systemd 執行。
- 打包產物名稱固定如下，infra 依這些名稱部署：

| 名稱 | 類型 | 產出位置 |
|---|---|---|
| `dispatcher` | Lambda zip | `aws/app/dist/dispatcher.zip` |
| `notifier` | Lambda zip | `aws/app/dist/notifier.zip` |
| `worker` | EC2 mjs | `aws/app/dist/worker.mjs` |
| `api` | EC2 mjs | `aws/api/dist/api.mjs` |
| `replay` | EC2 mjs | `aws/replay/dist/replay.mjs` |

## 3. 環境變數

所有服務都只從環境變數讀設定。本機開發時用 `aws/docker-compose.yml` 的 Postgres 與 LocalStack。

| 變數 | 用在 | 說明 |
|---|---|---|
| `AWS_REGION` | 全部 | 預設 `us-east-1`（Learner Lab） |
| `AWS_ENDPOINT_URL` | 全部（僅本機） | 指向 LocalStack `http://localhost:4566` |
| `DATABASE_URL` | worker、api（本機） | 有值時優先使用，例如 `postgres://mvdis:mvdis@localhost:5432/mvdis` |
| `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_SECRET_ARN` | worker、api（AWS） | 密碼存 Secrets Manager，secret 內容為 JSON `{"username":"…","password":"…"}` |
| `SCAN_QUEUE_URL` | dispatcher、worker | SQS 掃描佇列 |
| `EVENT_TOPIC_ARN` | worker | SNS 釋位事件 topic |
| `RAW_BUCKET` | worker | S3 資料湖 bucket |
| `MVDIS_BASE_URL` | worker | 真實站 `https://www.mvdis.gov.tw`；實驗時改成 Replay 站內網位址，例如 `http://replay.internal:8080` |
| `SCAN_TARGET` | dispatcher | `live`（預設）或 `replay` |
| `HOT_PER_TICK`、`COLD_PER_TICK` | dispatcher | 預設 11、3，**`live` 模式下兩者合計不得超過 14** |
| `DISCORD_SECRET_ARN` | notifier | secret 內容為 JSON `{"webhookUrl":"https://discord.com/api/webhooks/…"}` |
| `PORT` | api、replay | 預設 8080 |
| `WORKER_CONCURRENCY` | worker | 單台同時處理幾則訊息，預設 5 |

## 4. SQS 掃描任務（dispatcher → worker）

- 佇列：`mvdis-scan`，可見性逾時 60 秒，`maxReceiveCount = 3` 後進 `mvdis-scan-dlq`。
- 訊息 body 為 JSON，型別見 `aws/shared/contracts.ts` 的 `ScanTask`：

```json
{ "v": 1, "taskId": "uuid", "licenseType": "3", "lv1": "60", "dmvNo": "63",
  "tier": "hot", "target": "live", "runId": null, "enqueuedAt": 1794761624526 }
```

- `runId`：一般排程為 `null`；實驗時由 experiments 腳本直接灌入佇列，並帶上同一個 `runId`。
- **禮貌原則**：`target = "live"` 時，dispatcher 每分鐘最多送 14 則。灌大量任務的實驗一律 `target = "replay"`，worker 收到 `replay` 任務時必須打 `MVDIS_BASE_URL`，而且 `MVDIS_BASE_URL` 不能是官網。
- dispatcher 是**無狀態**的：用「從 epoch 起算的分鐘數」決定這一輪輪到哪一段熱門／冷門組合，不連資料庫、不放 VPC。
- 降頻（長期沒場次的組合 24 小時才查一次）由 worker 判斷：收到任務時查 `scan_log.empty_streak`，該跳過就直接刪訊息並記一筆 `skipped`。

## 5. worker 的處理流程與冪等性

1. 收訊息 → 寫 `scan_task_log.started_at`。
2. 抓頁面（`MVDIS_BASE_URL` + `/m3-emv-trn/exm/locations`），用 `src/mvdis.ts` 的 `parseSlots` 解析。
3. 單一交易內：`SELECT … FOR UPDATE` 鎖住該組合的既有 `slot` 列 → 比對差異 → 寫 `slot`、`slot_event`、`scan_log`、`scan_task_log`。
4. 交易提交後：
   - 原始 HTML（gzip）放 `s3://$RAW_BUCKET/raw/dt=YYYY-MM-DD/license=<code>/dmv=<no>/<epochMs>.html.gz`
   - 事件放 `s3://$RAW_BUCKET/events/dt=YYYY-MM-DD/<taskId>.jsonl`（每行一個 `SlotEvent`）
   - `kind = released` 的事件逐筆發到 SNS
5. 最後才刪 SQS 訊息。重送的訊息（同一 `taskId`）若 `scan_task_log.finished_at` 已有值就直接刪除，不重做。

## 6. SNS 釋位事件（worker → notifier）

- Topic：`mvdis-events`，訊息 body 為 `ReleasedEvent`（見 `aws/shared/contracts.ts`）。
- 訊息屬性 `target`（`live`／`replay`），notifier 的訂閱用 filter policy 只收 `live`，實驗不會洗版 Discord。

## 7. 資料庫

- RDS PostgreSQL 16，schema 見 `aws/db/schema.pg.sql`。由 worker 線的 migration 腳本（`aws/app` 的 `npm run migrate`）套用。
- 除了原型的表，另加 `scan_task_log`，給實驗量測「每輪耗時」與「有沒有漏掃」。

## 8. HTTP 介面

| 服務 | Port | 路徑 |
|---|---|---|
| api | 8080 | `GET /healthz`、`GET /api/meta`、`/api/available`、`/api/overview`、`/api/events`、`/api/slots`、`/api/station`（參數與回應格式和原型 `src/index.ts` 相同）；`GET /` 儀表板 |
| replay | 8080 | `GET /healthz`；`POST /m3-emv-trn/exm/locations`（表單欄位與官網相同，回傳同格式 HTML）；`POST /admin/reset` |

- api 的回應要帶 `Cache-Control: public, max-age=30`，讓 CloudFront 快取 30 秒。
- ALB 健康檢查打 `/healthz`，回 200 即健康。

## 9. CloudWatch 指標

- Namespace `MvdisWatch`，worker 用 Embedded Metric Format 寫 log：
  - `ScanDurationMs`、`ScanErrors`、`ReleasedEvents`，維度 `Tier`、`Target`。
- worker ASG 依 `ApproximateNumberOfMessagesVisible / InService 台數` 做 target tracking（目標值由 infra 決定）。

## 10. Learner Lab 限制（infra 與所有人都要遵守）

- 不能建 IAM role：EC2 用 `LabInstanceProfile`，Lambda 用 `LabRole`（Terraform 以 data source 取得 ARN）。
- 憑證約 4 小時過期、session 結束 EC2 會停：所有資源都要能 `terraform destroy` 後重建；資料庫內容不是唯一來源（原始資料在 S3、長期蒐集靠 Cloudflare 版）。
