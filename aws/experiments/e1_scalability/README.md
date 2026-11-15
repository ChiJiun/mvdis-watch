# E1 擴展性

兩部分，可以分開跑：

1. **API 端**：Locust 對公開 API 從 50 階梯加壓到 2,000 併發使用者，量每一階的 p95 回應時間與 API ASG 台數。
2. **佇列端**：一次灌 3,600 個 `target=replay` 的 `ScanTask`（同一 runId，360 組 × 10 次）到 SQS，量佇列清空時間與 worker ASG 台數。

## 需要的 AWS 輸出值

| 部分 | 值 |
|---|---|
| API 端 | `cloudfront_url`（Locust 的 `--host`）、`api_asg_name` |
| 佇列端 | `scan_queue_url`、`worker_asg_name`；讀 `scan_task_log` 時另需 `rds_endpoint`、`db_secret_arn` 等（見上層 README） |

## 1. API 端

```bash
# 終端機 A（bastion 或任何有憑證的地方）：每 15 秒記錄 API ASG 台數
python e1_scalability/monitor_asg.py --tf-outputs outputs.json --out results/e1/api-asg.csv

# 終端機 B（壓測機，t3.large 以上）：約 21 分鐘（7 階 × 180 秒）
locust -f e1_scalability/locustfile.py --headless --host "$API_BASE_URL" \
  --csv results/e1/locust --csv-full-history --processes -1

# 結束後整理成每階的 p95 與台數
python e1_scalability/analyze_locust.py --history results/e1/locust_stats_history.csv \
  --asg results/e1/api-asg.csv --name e1-api-$(date +%Y%m%d)
```

可調的環境變數見 `locustfile.py` 開頭：`E1_STEPS`、`E1_STEP_SECONDS`（預設 180，ASG 擴容要 3–5 分鐘）、
`E1_SPAWN_RATE`、`E1_CACHE_BUST_RATIO`。

**CloudFront 快取**：API 回 `Cache-Control: max-age=30`，CloudFront 的 cache policy 會把 query string 放進快取鍵。
預設 `E1_CACHE_BUST_RATIO=1.0`，每個請求帶隨機 `_cb` 參數，壓力會真的打到 ALB／ASG（量擴展性）；
設成 `0` 再跑一次，可以對照「有快取」時後端幾乎不受影響。

**量測**

| 指標 | 來源 |
|---|---|
| 每階 p95 | Locust history 的 Aggregated 滾動 p95，取每一階後半段的中位數（避開剛加壓、還沒擴容的暫態） |
| 每階 RPS、失敗率 | 同上 |
| API ASG 台數 | `monitor_asg.py`，取每一階期間的最大 InService |

## 2. 佇列端

```bash
python e1_scalability/enqueue_burst.py --dry-run          # 先乾跑
python e1_scalability/enqueue_burst.py --tf-outputs outputs.json --count 3600 --watch
```

`--watch` 會每 15 秒記錄 visible／inFlight 與 worker ASG 台數，直到佇列清空，再從 `scan_task_log` 讀這個 runId 的完成情況。

**量測**

| 指標 | 定義 |
|---|---|
| 佇列清空時間 | 開始送出 → visible、inFlight、delayed 都歸零 |
| 尖峰台數 | 監看期間 worker ASG 的最大 InService |
| 完成耗時 | `scan_task_log`：最後 `finished_at` − 最早 `enqueued_at` |
| 漏掃、錯誤、重送 | `scan_task_log` 的 outcome 與 `receive_count` |

注意：worker ASG 依 `ApproximateNumberOfMessagesVisible / InService` 做 target tracking（infra 預設目標 50），
3,600 則一進來就會觸發擴容。Replay 站的回應延遲（預設 500±250 ms）決定單台吞吐量，報告要寫明當時的設定
（`GET <replay>/admin/stats` 看得到）。

## 本機乾跑

```bash
python e1_scalability/enqueue_burst.py --dry-run
python e1_scalability/monitor_asg.py --dry-run

# locustfile 對本機假 API 跑 20 秒（需要 pip install locust）
python e1_scalability/stub_api.py --port 8099 &
E1_STEPS=5,10 E1_STEP_SECONDS=10 locust -f e1_scalability/locustfile.py --headless \
  --host http://127.0.0.1:8099 --csv results/e1/dry --csv-full-history
python e1_scalability/analyze_locust.py --history results/e1/dry_stats_history.csv --name dry --dry-run
```
