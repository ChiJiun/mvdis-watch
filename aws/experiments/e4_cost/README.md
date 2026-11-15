# E4 成本

比較三種執行模型的**每千次掃描成本**與**月成本**。純計算，不連 AWS。

```bash
python e4_cost/cost_model.py                                     # 預設假設
python e4_cost/cost_model.py --from-e3 results/e3/<prefix>.json  # 用 E3 實測的單次掃描時間
python e4_cost/cost_model.py --scenarios 14,36,360 --lambda-memory-mb 512 --worker-instance-type t3.small
```

## 三種模型

| 模型 | 運算成本怎麼算 |
|---|---|
| Cloudflare Workers（原型） | 每分鐘一次 cron。實測 CPU 最壞 6.45 ms／次（每次 14 組），每組 CPU 依此線性外推。CPU ≤ 10 ms、subrequest ≤ 50、請求 ≤ 10 萬／天 → 免費方案 $0；否則付費方案 $5／月＋超量 |
| EC2 ASG worker | 台數 = max(2, ⌈每秒掃描數 ÷ (WORKER_CONCURRENCY ÷ 單次掃描秒數 × 目標使用率 0.6)⌉)，乘 t3 時薪 × 730 小時＋EBS |
| Lambda worker | 每則訊息一次 invocation，計費時間 = 單次掃描牆鐘時間＋攤提冷啟動，× 記憶體（預設 256 MB）× GB-秒單價＋請求費；另加 SQS 事件來源的長輪詢 |

兩種 AWS 模型另外都要付、且和掃描次數成正比的：SQS 請求（每次掃描 3 次 API）、NAT Gateway 資料處理（每次約 70 KB 的官網頁面）、
S3（gzip 原始頁面＋PUT）。

**平台固定成本**（兩種 AWS 模型相同，單獨列出）：RDS db.t3.micro Multi-AZ、2 個 NAT Gateway、ALB、API ASG 2 台。

## 情境

| 每分鐘掃描組數 | 意義 |
|---|---|
| 14 | 目前對官網的禮貌上限（live） |
| 36 | 360 組每 10 分鐘一輪（原型的偵測延遲） |
| 360 | 360 組每分鐘一輪：系統能力上限，只能對 Replay 站做。NAT 流量照「對外抓取」計算，代表若官網允許時的成本 |

## 輸出

終端機印出對照表，`results/e4/<name>.json` 有每個模型的成本分項（`scanning`、`platformFixed`），出圖腳本畫成 `e4_cost.png`。

## 價格與假設（**報告引用前要校正**）

- `prices.json` 是 us-east-1 隨需牌價，取自撰寫時已知的公開價格，**尚未對照當期 AWS Pricing Calculator 與 Cloudflare 價目表**，
  `asOf` 標為「未校正」。引用前逐項核對並更新 `asOf`。
- 不含免費方案額度（Learner Lab 帳單也不適用一般帳號的免費額度）。
- 單次掃描時間預設 800 ms 是假設值；跑完 E3 後用 `--from-e3`（取最大台數那一輪的服務時間 p50）。
- Cloudflare 的「CPU 最壞 6.45 ms」解讀為**每次 cron 呼叫（14 組）**的 CPU 時間；如果原始量測其實是每組，
  把 `DEFAULTS['cfScansPerInvocationMeasured']` 改成 1。
- Cloudflare 模型沒有算 D1 的讀寫額度（原型已把每次 cron 的 D1 查詢壓在 50 次以內），也沒有 S3／NAT（原型不存原始頁面），
  所以「每千次成本」的對照不是完全同功能，報告要說明 AWS 版多了資料湖與高可用。
