# Replay 模擬站

模擬監理服務網的查詢端點，給 VPC 內的高頻實驗（E1–E3）打，避免對官網造成負擔。
回傳的 HTML 和官網同格式，原型 `src/mvdis.ts` 的 `parseSlots` 可以直接解析。

```bash
npm install
npm test          # 單元＋HTTP 整合測試（含：產生的列和官網真實列逐字相同、360 組都能被 parseSlots 解析）
npm run build     # → dist/replay.mjs（單一 ESM 檔，fixture 已嵌入；infra 上傳到 S3 後由 EC2 執行）
npm run smoke     # 啟動 dist/replay.mjs，用原型的表單格式打完 360 組並用 parseSlots 解析
npm run typecheck
```

需要 Node.js 22.6 以上（測試用 `--experimental-strip-types` 直接跑 TypeScript）。

## HTTP 介面（契約第 8 節）

| 路徑 | 說明 |
|---|---|
| `GET /healthz` | ALB／健康檢查，回 `{ ok, combos, requests, uptimeMs }` |
| `POST /m3-emv-trn/exm/locations` | 接受契約 §4.3（`contracts.ts` 的 `mvdisFormFields`）的全部欄位，回傳整頁 HTML。`expectExamDateStr`（民國 yyyMMdd）只列該日（含）之後的場次，格式不對則不過濾；`onlyWeekend=true` 只列星期六、日（不模擬國定假日）；`_onlyWeekend`、`secDateStr`、`secId`、`divId` 收下不處理。`dmvNoLv1` 和站別對不上、或組合不存在時，照樣回 200 但表格是空的。其他 `method` 回 400、非 POST 回 405 |
| `POST /admin/reset` | 還原成 seed 決定的初始狀態；可帶 JSON 同時換參數，例如 `{"flipProb":0,"tickMs":1000,"flipsPerTick":2,"delayMs":500}`。未知欄位或越界值回 400 |
| `GET /admin/stats` | 組合數、場次數、有位數、請求數、擾動事件數與目前設定 |
| `GET /admin/events?after=<seq>&kind=released&limit=5000` | 擾動紀錄（E3 用來算「釋位 → 偵測」延遲） |

`/admin/*` 之後兩個是契約以外、只給 experiments 用的端點。設定 `REPLAY_ADMIN_TOKEN` 時 `/admin/*` 要帶 `x-admin-token` 標頭。

## 資料模型

- **模板**：`fixtures/raw/available.html` 的頁面外殼（`<tbody>` 之前與 `</tbody>` 之後）。表格列由 `src/generator.ts` 的 `renderRow()`
  依真實頁面的列格式重新產生（CRLF 換行、縮排、`preAdd(...)` 參數都相同，測試逐字比對）。
- **360 組**：每組依 `seed + 照類 + 站別` 決定性產生 1–3 條場次軌（上午／下午 × 組別），排在「台灣時間今天＋3 天」起的 30 天工作日
  （少數組合有星期六）。熱門照類 5%、冷門照類 35% 的組合沒有場次（例如恆春分站不考聯結車）。初始 70% 額滿。
- **擾動**：
  - request 模式（`REPLAY_FLIP_PROB`，預設 0.02）：每次查詢該組合時，每個場次以此機率翻轉（額滿 → 有位 1–3 位 ＝ 釋位，或有位 → 額滿），
    翻轉發生在產生回應的那一刻，所以這次回應就看得到。
  - clock 模式（`REPLAY_TICK_MS` > 0）：每隔 tickMs 從全部場次隨機挑 `REPLAY_FLIPS_PER_TICK` 個翻轉，和請求無關，用來量偵測延遲。
  - 每次翻轉都記一筆事件（環形緩衝，上限 `REPLAY_MAX_EVENTS`）。
- 頁面外殼裡的表單回填值（選取的照類／站別）固定是模板那一頁（豐原站普通重型機車），`parseSlots` 不讀這段，所以不影響解析。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | 8080 | |
| `REPLAY_SEED` | 20261116 | 決定 360 組的場次與初始名額 |
| `REPLAY_FLIP_PROB` | 0.02 | request 模式的翻轉機率（0–1） |
| `REPLAY_TICK_MS` | 0 | clock 模式間隔，0 = 關閉 |
| `REPLAY_FLIPS_PER_TICK` | 5 | |
| `REPLAY_FULL_RATIO` | 0.7 | 初始額滿比例 |
| `REPLAY_HORIZON_DAYS` | 30 | |
| `REPLAY_DELAY_MS`／`REPLAY_JITTER_MS` | 500／250 | 每次回應等待 delay ± jitter 毫秒，模擬官網。**這是假設值，沒有用官網實測校準** |
| `REPLAY_MAX_EVENTS` | 100000 | |
| `REPLAY_ADMIN_TOKEN` | （無） | |

數字格式錯誤或越界時服務會直接起不來，避免默默用預設值跑錯實驗。

## Fixture 擷取（對官網的禮貌限制）

`fixtures/raw/` 是 2026-11-16 從官網抓的 4 頁真實頁面：

| 檔案 | 組合 | 用途 |
|---|---|---|
| `available.html` | 豐原站普通重型機車 | 模板外殼；有位列與額滿列的格式 |
| `full.html` | 板橋站普通重型機車 | 全額滿頁面 |
| `empty.html` | 恆春分站職業聯結車 | 無場次頁面（空表格格式） |
| `car.html` | 臺南站普通小型車 | 汽車照類的場次說明文字 |

只抓 4 頁而不是 360 頁：模擬站要的是「HTML 長什麼樣子」，不是各組的真實餘額；這 4 頁涵蓋了 `parseSlots` 會遇到的所有列型態，
360 組的變化由程式產生。

```bash
npm run fixtures:dry-run     # 只印出會抓哪幾頁
npm run fixtures:capture     # 真的抓（會扣預算）
npm run fixtures:capture -- --only empty
```

`scripts/capture-fixtures.ts` 的硬性限制：兩次請求至少間隔 5 秒（跨次執行也算），整個開發期間總共最多 40 次，
用 `fixtures/capture-budget.json` 記帳並 commit 進 repo（目前已用 4 次）。請求一律先記帳再送出。

官網頁面是 CRLF 換行，`.gitattributes` 把 `fixtures/raw/*.html` 標成 `-text`，避免 `core.autocrlf` 讓不同平台 build 出不同的模板。
