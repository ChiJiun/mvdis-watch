# 監理站考照餘額監測

持續掃描全台 36 個監理站 × 10 種照類的考照場次餘額，把「現在有位」和「剛剛釋出」攤在一個儀表板上，
每個監理站還有自己的公開頁面：含額滿的完整場次表、釋位歷史統計，以及一支任何人都能取用的 JSON API。

熱門站點（例如板橋站普通重型機車）常常未來一整個月的場次全部額滿，唯一的機會是別人退考釋位——這個網站就是幫你盯著那一刻。

## 這是什麼、不是什麼

- **是**唯讀的監測看板。資料來自監理服務網公開的查詢頁面，沒有驗證碼、不需要登入。
- **不代辦報名**。有位時只給你官網連結，報名要自己去填（涉及身分證字號與體檢資料）。
- **不是即時的**。見下方更新頻率。實際餘額一律以官網為準。

### 更新頻率

沒有「即時」這回事——官網沒有推播，只能定時去查。實際的延遲是這樣：

| | 週期 | 意思 |
| --- | --- | --- |
| 熱門照類（輕機／重機／普通小型車，108 組） | **約 10 分鐘** | 有人退考釋位後，最慢 10 分鐘會出現在看板上 |
| 冷門照類（職業／大車／聯結車，252 組） | **約 2 小時** | 這些幾乎不會滿，不值得高頻掃 |
| 長期無場次的組合（實測有 153 組） | 24 小時 | 例如恆春分站不考聯結車，自動降頻 |
| 儀表板畫面 | 30 秒 | 只是重讀資料庫，不會加快抓取 |

想讓熱門層更快，就把 `wrangler.toml` 的 `HOT_PER_TICK` 調大（例如 22 → 約 5 分鐘一輪），
代價是對監理服務網的請求量翻倍，而且更容易撞到 Workers 免費方案的 CPU 上限。

## 每站頁面

`/station/<dmvNo>`，例如 `/station/41` 是板橋監理站、`/station/41?type=3` 直接切到普通重型機車。
網址可以直接分享，Worker 會替每一站注入標題與 OG 標籤，貼到聊天軟體會顯示站名。

頁面上有：

- **完整場次表（含額滿）**。首頁只列有位的，這裡把額滿的也攤出來，因為額滿的場次才是會釋位的那些。
- **釋位統計**（最近 30 天）：釋位次數、最近一次釋位、釋位後多久被搶光的中位數、最常釋位的時段，
  以及每小時／每日的釋位次數分布。時間解析度受掃描頻率限制：熱門照類約 10 分鐘掃一次，
  所以「被搶光」低於 15 分鐘的都顯示為「約 10 分鐘內」。
- **變化紀錄**：這一站最近的釋出／額滿／新場次／移除事件。
- **監理站基本資料**：電話（可直接撥）、傳真、所轄區域與 Google 地圖連結。
  來自政府資料開放平臺的交通部公路局「[監理機關轄區](https://data.gov.tw/dataset/86521)」資料集，
  依[政府資料開放授權條款第 1 版](https://data.gov.tw/license)使用；靜態寫在 `src/station-info.ts`，
  不進 D1、不加 cron，要更新就跑 `npm run stations:info` 重新產生（對不上的站名會印出來）。

站別代號見 `src/catalogue.ts` 或 `/api/meta`。`/sitemap.xml` 列出全部 36 站。

## 公開 JSON API

所有 GET 端點都允許跨網域讀取（CORS `*`），並有 **30 秒的邊緣快取**——不管多少人開著頁面，
D1 每 30 秒最多只被同一個查詢讀一次。`/api` 本身會回傳端點清單。

| 端點 | 內容 |
| --- | --- |
| `/api/meta` | 站別（含電話、傳真、所轄區域）、照類對照、掃描健康度、最後一次掃描時間 |
| `/api/available` | 目前有餘額的場次。參數：`dmvNo`、`licenseType`、`county`、`lv1`、`from`、`to`、`weekendOnly=1`、`minQuota`、`limit` |
| `/api/overview` | 每個「監理站 × 照類」目前有位的場次數與名額數 |
| `/api/station?dmvNo=41` | 單一站的基本資料（電話、傳真、所轄區域）、完整場次表（含額滿）、每照類釋位統計、最近 200 筆事件、掃描健康度 |
| `/api/slots?licenseType=3&dmvNo=41` | 單一「照類 × 監理站」的完整場次表 |
| `/api/events` | 最近的變化事件流。參數：`kind`、`limit` |

`quota` 為 `-1` 代表額滿。事件只保留 30 天，所以統計的視窗也是 30 天。
`/api/subscriptions*` 與 `/api/scan` 不是公開端點，需要 token，也不快取。

## 架構

單一 Cloudflare Worker 同時扮演三個角色：cron 抓取器、公開 API、靜態前端來源。

```
Cron (每分鐘) ─► scheduled() ─► 取下一分片 → 併發抓取 → 解析 → 差異寫入 D1
                                                                    │
瀏覽器 ─► fetch()  /               靜態儀表板 (Workers Assets)       │
                   /station/41     station.html + 注入標題/OG ◄──────┤
                   /api/*          公開 JSON，30 秒邊緣快取 ◄─────────┤
                   /sitemap.xml    36 站的站台地圖                    │
                   /robots.txt     允許索引頁面、不索引 /api/          │
```

| 檔案 | 職責 |
| --- | --- |
| `src/mvdis.ts` | 抓取與解析核心，可獨立於 Cloudflare 執行 |
| `src/catalogue.ts` | 36 站 + 10 照類的對照表 |
| `src/station-info.ts` | 36 站的電話、傳真、所轄區域（由 `scripts/stations-info.mjs` 自開放資料產生） |
| `src/scan.ts` | 分層分片排程、降頻、清理 |
| `src/db.ts` | D1 存取與差異比對 |
| `src/stats.ts` | 釋位歷史統計（純計算） |
| `src/index.ts` | Worker 進入點、API 路由、快取、每站頁面注入 |
| `public/` | 儀表板與每站頁面（原生 ES module，無打包步驟） |
| `scripts/sweep.mjs` | 本機驗證用，不碰 Cloudflare |
| `scripts/stations-info.mjs` | 下載開放資料、對應站名、產生 `src/station-info.ts` |

## 免費方案實測

**全部跑在免費額度內，不用付錢。** 但這不是想當然耳的——D1 免費方案有一條
「每次 Worker 呼叫最多 50 個查詢」的限制很容易踩到，整個資料層是為了它而設計的。

以下都是實際量出來的數字，不是估算：

| 限制（免費方案） | 上限 | 實測用量 | 餘裕 |
| --- | --- | --- | --- |
| Workers subrequest / 次 | 50 | **14** | 充足 |
| Workers CPU / 次 | 10 ms | **6.45 ms** 最壞、約 2 ms 典型 | 最緊 |
| D1 查詢 / 次 | 50 | **39** 首次建表最壞、**7–12** 穩態 | 尚可 |
| D1 寫入列 / 日 | 100,000 | 約 3,000–5,000 | 充足 |
| D1 讀取列 / 日 | 5,000,000 | 約 50 萬 | 充足 |
| Workers 請求 / 日 | 100,000 | 1,440 次 cron + 訪客流量 | 充足；API 有 30 秒快取，每個訪客約 2 次/分鐘 |
| D1 儲存 | 5 GB | 約 1 MB | 充足 |

CPU 的 6.45 ms 是**最壞情況**：假設一次 tick 的 14 頁全都是豐原站那種
92 KB / 66 列的重量級頁面。實際全 360 組平均每組只有 7.7 列，典型 tick 約 2 ms。

**餘裕最小的是 CPU。** 若 `wrangler tail` 出現 CPU 超標，把 `wrangler.toml` 的
`HOT_PER_TICK` / `COLD_PER_TICK` 調小即可。真的想加速再考慮 Workers Paid
（US$5/月，30 s CPU + 1000 subrequests，可以一次掃完 360 組）——但**不是必要的**。

其他也都免費：GitHub、Cloudflare 的 `*.workers.dev` 網域。唯一要花錢的只有
你想綁自己的網域。

## 幾個設計決定的理由

**只寫變動的列。** 全量寫入約每天 40 萬列，會撞破 D1 免費方案的 10 萬列/日上限。只寫差異之後每天只剩幾千列，而且差異本身就是我們要的釋位事件。所以請不要為了記錄「最後看到時間」而每輪更新每一列。

**讀取合併、寫入分塊。** D1 免費方案每次 Worker 呼叫最多 50 個查詢，而且 batch 裡每個 statement 都各算一個。所以「每個組合各跑一次 SELECT、各寫一次 scan_log」這種直覺寫法，14 個組合就 35 次起跳、變動一多就爆掉。現在讀取固定只有 3 個查詢（降頻清單、排程狀態、一次撈完所有既有場次），寫入則合併成多列 statement——但每個查詢最多 100 個綁定參數，所以 slot（14 欄）每個 statement 最多 7 列、slot_event（8 欄）最多 12 列。

**寫入有預算上限。** 首次建表時變動量最大，`WRITE_BUDGET` 會在 statement 數逼近上限時停下，該輪只套用前面幾個組合、游標不前進，下一輪再繼續。代價是第一次填滿資料庫比較慢，換來的是**任何情況下都不會超過 50 個查詢**（實測最壞 39）。

**場次鍵從說明文字推導，不是從官網的 `preAdd()` 參數。** 「額滿」的列沒有報名連結、拿不到 `preAdd` 參數；如果兩種狀態用不同的鍵，同一個場次從有位變額滿時會被誤判成「一個場次消失＋另一個出現」，事件流就髒了。

**解析前先把 HTML 切片。** 官網回應是整頁 70 KB，我們只要 `id="trnTable"` 那一段（約 15 KB）。Workers 免費方案單次 CPU 只有 10 ms，對整頁跑正則會很緊。

**分層掃描。** 實測 360 個組合中有 153 個根本沒有任何場次（例如恆春分站不考聯結車），而會被搶的只有機車和普通小型車。全部同頻率掃是對政府網站的浪費。連續 5 次抓到空結果的組合會自動降頻成每 24 小時複查一次。

## 本機開發

```bash
npm install
```

驗證抓取核心（直接打官網，不需要 Cloudflare 帳號）：

```bash
npm run sweep -- --fixtures
```

掃過全部 360 個組合，印出目前有餘額的場次：

```bash
npm run sweep
```

### 在本機實際監測（不需要 Cloudflare 帳號）

要開**兩個終端機**。`wrangler dev` 不會自己觸發 cron，所以需要 `npm run tick`
每分鐘去戳一次 `/__scheduled` —— 走的是跟正式環境完全相同的程式路徑。

終端機 1，起服務（含本地 D1）：

```bash
npm run db:init && npm run dev
```

終端機 2，開始定時掃描：

```bash
npm run tick
```

然後開 http://127.0.0.1:8788 ，每站頁面在 http://127.0.0.1:8788/station/41 。剛起來時資料是空的，熱門照類要約 10 分鐘才會輪完
第一圈，儀表板才會長滿。關掉終端機就停止監測，但已抓到的資料留在 `.wrangler/`
裡，下次起來會接著跑。

也可以不靠排程，手動觸發單獨一輪（token 寫在 `wrangler.toml`）：

```bash
curl -X POST -H "x-scan-token: dev-only-change-me" http://127.0.0.1:8788/api/scan
```

## 通知綁定（Discord）

只在你 ★ 追蹤的「監理站 × 照類」**從額滿變成有位**時推播——那是退考釋出、也是唯一
值得搶的那一刻。`increased`（本來就有位、數量變多）和 `new`（新開場次）不推，
否則熱門站一天會轟你幾十則，然後你就會關掉通知。

1. Discord 裡：頻道 → 編輯頻道 → 整合 → Webhook → 建立 → 複製網址
2. 網站右上角「🔔 通知設定」→ 輸入 `ADMIN_TOKEN` → 貼上 webhook 網址
3. 先回表格點幾個 ★ 追蹤，再按「用目前追蹤清單建立訂閱」
4. 按「測試」確認訊息真的進得了你的頻道

> ⚠️ **webhook 網址等同密鑰**，存在 D1 裡。任何拿到它的人都能往你的頻道發訊息。
> 所以 `/api/subscriptions` 全系列端點都需要 `ADMIN_TOKEN`，API 回傳時網址也會遮罩。
> 真的外流就去 Discord 刪掉重建一個。

推播上限是每輪 5 則（每個訂閱一則、多個場次合併在同一則），這是為了守住
Workers 免費方案單次 50 個 subrequest 的限制——抓取已經用掉 14 個。

## 部署到 Cloudflare：免費、24/7、有公開網域

Cloudflare Workers 免費方案給你一個 `https://<worker名>.<你的帳號子網域>.workers.dev`
的公開網址，有 HTTPS、全球 CDN、不用備案、不用信用卡。伺服器由 Cloudflare 跑，
你的電腦關機也不影響。

需要一個免費的 Cloudflare 帳號。以下指令請你自己執行——登入與建立資源會綁定你的帳號。

1. 登入：

```bash
npx wrangler login
```

2. 建立 D1 資料庫，把回傳的 `database_id` 填進 `wrangler.toml`：

```bash
npx wrangler d1 create mvdis
```

3. 套用 schema：

```bash
npx wrangler d1 execute mvdis --remote --file=schema.sql
```

4. 設定兩個 token。**別沿用 `wrangler.toml` 裡的開發預設值**——那個檔案在公開 repo 裡，
   全世界都看得到。`SCAN_TOKEN` 沒改，`/api/scan` 會變成別人拿來打監理站的跳板；
   `ADMIN_TOKEN` 沒改，任何人都能讀走你的 Discord webhook 網址：

```bash
npx wrangler secret put SCAN_TOKEN
```

```bash
npx wrangler secret put ADMIN_TOKEN
```

5. 部署。跑完會印出你的公開網址：

```bash
npx wrangler deploy
```

6. 部署後 `https://<worker名>.<子網域>.workers.dev/station/41` 就是板橋站的公開頁面，
   `/sitemap.xml` 可以直接提交給 Google Search Console。

7. 確認 cron 真的有在跑，並且看實際 CPU 用量：

```bash
npx wrangler tail --format pretty
```

部署後 cron 每分鐘自動觸發，不需要你的電腦開著。熱門照類約 10 分鐘輪完一圈，
所以第一次要等十幾分鐘資料才會長滿。

### 想換成自己的網域（唯一要花錢的地方）

`*.workers.dev` 已經是公開可用的正式網址。若要換成自己的網域，網域本身要自己買
（Cloudflare Registrar 約 US$10/年起），但把它接到 Worker 是免費的：把網域加進
Cloudflare、DNS 指過去，然後在 `wrangler.toml` 加上 route 設定重新部署即可。

### 部署後要檢查的三件事

1. **Cloudflare 出得去嗎。** Worker 的出口 IP 遍布全球，監理服務網有可能對非台灣 IP 有限制。`wrangler tail` 若持續看到抓取失敗，就是被擋了——退路是把抓取搬到 GitHub Actions（cron 產出 JSON），Worker 只留 API 與前端。
2. **CPU 有沒有超標。** 免費方案單次 10 ms。`wrangler tail` 會顯示每次 cron 的 CPU 時間；若超標就把 `wrangler.toml` 裡的 `HOT_PER_TICK` / `COLD_PER_TICK` 調小（代價是輪完一圈變慢），或升級 Workers Paid（US$5/月，30s CPU + 1000 subrequests，可以一次掃完 360 組）。
3. **D1 寫入量。** Cloudflare dashboard 看 D1 的 rows written。正常應該遠低於每天 10 萬列。

## 資料來源

`POST https://www.mvdis.gov.tw/m3-emv-trn/exm/locations`

| 參數 | 說明 |
| --- | --- |
| `method` | `query` 查場次／`dmvOnChange` 取站別清單 |
| `licenseTypeCode` | `5` 輕機、`3` 重機、`A` 普小、`B` 職小、`C` 普大貨、`D` 職大貨、`E` 普大客、`F` 職大客、`G` 普聯結、`H` 職聯結 |
| `expectExamDateStr` | 民國日期 `yyyMMdd`，例如 `1150806` |
| `dmvNoLv1` | 區監理所 `20`/`40`/`50`/`60`/`70`/`30`/`80` |
| `dmvNo` | 監理站，見 `src/catalogue.ts` |
| `onlyWeekend` | 只查週末假日場次 |

回應是整頁 HTML，場次在 `id="trnTable"` 的表格內：考試日期 / 場次組別說明 / 可報名人數（數字或「額滿」）/ 報名連結。

若官網日後加上驗證碼或改變結構，這個專案就會停在那裡——不會去繞驗證機制。站別清單改制時用 `npm run sweep -- --stations` 重新產生 `src/catalogue.ts` 的內容。
