# api：公開 API 服務（EC2 ASG）

原型 `src/index.ts` 的公開 JSON API 與儀表板頁，移植成跑在 EC2 上的 Node 服務，資料來源改成 RDS PostgreSQL。
介面以 [`aws/CONTRACTS.md`](../CONTRACTS.md) 第 3、8 節為準。

## 端點

| 路徑 | 說明 |
|---|---|
| `GET /healthz` | 連得到 DB 回 200 `{"ok":true}`，否則 503。給 ALB 健康檢查，`Cache-Control: no-store`。走**獨立的 1 條連線**（不和 API 查詢搶連線池），成功結果快取 2 秒。那條連線有 2.5 秒的用戶端查詢逾時，DB 無聲斷線時會被丟掉重連，最壞約 2.5 秒回 503，DB 恢復後下一次檢查就回 200 |
| `GET /api`、`/api/meta`、`/api/available`、`/api/overview`、`/api/events`、`/api/slots`、`/api/station` | 參數與回應格式和原型相同，帶 `Cache-Control: public, max-age=30` 與 CORS |
| `GET /`、`/station/:no` | 儀表板與每站頁面（原型 `public/` 的檔案，build 時內嵌進 `api.mjs`） |
| `GET /app.js`、`/station.js`、`/style.css`、`/station.html`、`/robots.txt`、`/sitemap.xml` | 前端資源 |

沒有移植：`/api/subscriptions*`、`/api/scan`（AWS 版的推播與排程由 notifier／dispatcher 負責）。
儀表板的「通知設定」面板因此不會有作用（會拿到 404）。

### 和原型不同的地方

- **lastTick**：原型讀 `scan_state.last_tick`，AWS 版沒有這張表，改成 `scan_log` 的 `last_ok`／`last_error_at` 最大值
  （最近一次有組合被掃的時間）。理由見 `src/queries.ts` 的 `queryLastTick`。
- **參數驗證**：`from`／`to` 不是合法的 `YYYY-MM-DD` 時回 400（Postgres 的 DATE 不能拿任意字串比較）；
  `limit`／`minQuota` 不是數字時用預設值；`minQuota` 超過 int4 範圍時夾到上限（查不到東西），不會變成 500。
- **事件同一個 `at` 時的順序**：明寫 `id ASC`，和原型 SQLite 走索引的實際順序相同。
- **`/api/available` 同一個 `(exam_date, quota)` 的順序**：原型沒有指定，SQLite 實際是掃描順序；這裡補上主鍵排序讓結果穩定。
  正式資料同分很多，`limit` 邊界切到的列可能和原型不同（無法複製原型的掃描順序，測試資料刻意讓 quota 不重複，所以沒有比對這點）。
- **含 NUL 的文字參數**：Postgres 的 TEXT 不能含 NUL，這裡直接回空陣列（和原型查不到東西的結果相同）；年份 0000、壞網址回 400。
- **只讀 `public` schema**：每條連線固定 `search_path=public`、`DateStyle=ISO`（CONTRACTS.md §7.1、§7.3），不會讀到 `replay` 的實驗資料。
- **錯誤訊息**：未預期錯誤回 `{"error":"internal error"}`，細節只寫 log。
- **快取**：原型在 Worker 內用 Cache API；這裡只帶標頭，快取交給 CloudFront，行程內不快取。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8080` | |
| `DATABASE_URL` | — | 有值時優先使用（本機） |
| `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_SECRET_ARN` | `DB_PORT=5432` | AWS 上用；帳密從 Secrets Manager 讀 |
| `AWS_REGION`、`AWS_ENDPOINT_URL` | `us-east-1` | Secrets Manager 用 |
| `DB_POOL_MAX` | `10` | 每台給 API 查詢用的連線池上限。另有 1 條健康檢查專用連線，所以 RDS 連線數 ≈ 台數 × (這個值 + 1)，要和 RDS 機型的 `max_connections` 一起算 |
| `DB_SSL` | `DB_HOST` 路徑 `no-verify`；`DATABASE_URL` 路徑 `disable` | `disable`／`no-verify`／`verify`。RDS PostgreSQL 15 起預設 `rds.force_ssl=1`，不開 SSL 會連不上 |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` | 單一查詢逾時（伺服器端）。用戶端另有 `這個值 + 2000` 毫秒的查詢逾時，DB 無聲斷線時才不會一直掛著 |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | 從連線池取得連線的等待上限，包含排隊等空出來的連線，以及需要開新連線時的 TCP＋TLS＋認證時間。**排隊超過這個時間的 API 請求回 500**，解讀 E1 的錯誤率與 p95 時要考慮這個值 |
| `PUBLIC_ORIGIN` | 從 `Host` 與 `X-Forwarded-Proto` 推 | 對外網址，寫進每站頁面的 canonical 與 sitemap。**部署時應設成 `https://<CloudFront 網域>`**：CloudFront→ALB 走 http，X-Forwarded-Proto 會是 http；Host 是 CloudFront 還是 ALB 網域取決於快取／origin request policy。`X-Forwarded-Host` 一律不信任 |

後面六個是 api 自己的選用變數，不設也能跑，所以沒有寫進 CONTRACTS.md。

## 開發

```bash
cd aws/api
npm ci
npm run build        # → dist/api.mjs（單一 ESM 檔，含 pg、AWS SDK 與前端靜態檔）
npm run typecheck
npm test             # 需要 Postgres，見下方
```

測試需要一個 Postgres。預設連 `postgres://mvdis:mvdis@localhost:5432/mvdis`（`docker compose -f aws/docker-compose.yml up -d postgres`），
可用 `TEST_DATABASE_URL` 覆寫。測試會自己建立並重建 `mvdis_api_test` 資料庫、套 `aws/db/schema.pg.sql`，不會動到其他資料庫。

測試的核心是**和原型逐欄比對**：同一份測試資料同時灌進原型的 SQLite schema（用 `node:sqlite` 模擬 D1）與 Postgres，
由原型自己的 `src/index.ts` 與這個服務分別回應，比對狀態碼、快取標頭與 JSON 內容。

本機跑起來：

```bash
DATABASE_URL=postgres://mvdis:mvdis@localhost:5432/mvdis npm start
```

## 部署（infra 參考）

- 產物：`dist/api.mjs`，上傳到 `s3://<artifact_bucket>/releases/api.mjs`，EC2 上 `node api.mjs` 即可，不需要 `node_modules`。
- 需要 Node.js 22（Amazon Linux 2023 的 `nodejs22`）。
- 收到 `SIGTERM` 會停止收新連線、等進行中的請求做完再關連線池（最多 20 秒）。
- `keepAliveTimeout` 設為 65 秒，比 ALB 預設的 60 秒閒置逾時長，避免高併發時 ALB 回 502。
