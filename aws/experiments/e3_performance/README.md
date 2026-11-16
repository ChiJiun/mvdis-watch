# E3 效能

依序把 worker ASG 釘在 1／2／4／8 台，各掃一輪 replay 任務（預設 360 則，`--repeat` 可加倍），量：

| 指標 | 定義 |
|---|---|
| 耗時 T(n) | 量測輪的 `public.scan_task_log`（`target='replay'`）：最後 `finished_at` − 最早 `enqueued_at` |
| speedup | T(1) / T(n)；平行效率 = speedup / n |
| 偵測延遲（實測） | Replay 站 clock 模式產生的釋位時間（`/admin/events`）→ worker 寫入 `replay.slot_event(kind='released')` 的時間，取 p50／p95；分類見下方「解讀注意」 |
| 偵測延遲（推估） | 持續輪掃時，最壞 ≈ T(n)、平均 ≈ T(n)/2；對照原型約 10 分鐘 |
| 單次掃描服務時間 | `finished_at − started_at` 的 p50／p95（E4 成本模型會用到） |

## 需要的 AWS 輸出值

`scan_queue_url`、`worker_asg_name`、`replay_base_url`，以及資料庫設定（`rds_endpoint`、`rds_port`、`db_name`、`db_secret_arn`）。

## 步驟

```bash
aws events disable-rule --name mvdis-dispatch-every-minute     # 暫停排程，避免搶 worker
python e3_performance/run_scaling.py --dry-run
python e3_performance/run_scaling.py --tf-outputs outputs.json --workers 1,2,4,8
aws events enable-rule --name mvdis-dispatch-every-minute
```

每一階 n：

1. ASG 設為 `min=max=desired=n`（釘住台數，避免 target tracking 在量測中途擴縮），等 InService 剛好 n 台，再等 `--settle`（60 秒）讓 worker 程式啟動
2. 清空 replay schema（`TRUNCATE replay.slot, replay.slot_event, replay.scan_log`；`--keep-replay-db` 可略過），
   Replay 重設成固定 seed、不擾動，灌一輪「暖身」360 組 → `replay.slot` 和 Replay 初始狀態一致
3. Replay 再重設成**同一個 seed**（狀態和暖身時完全相同），開啟 clock 擾動（預設每秒釋位 2 個場次）
4. 灌量測輪 360 × `--repeat` 則（`runId = <prefix>-n<n>`），等全部完成
5. 結束後（含例外）把 ASG 還原成原本的 min/max/desired，Replay 關掉擾動；兩項各自處理，ASG 還原失敗會印出手動指令，Replay 仍會被還原

為什麼要暖身：資料庫若沒有和 Replay 同步，量測輪會寫出大量 `new`／`gone` 事件，寫入量和穩態不同，
而且無法判斷某個 `released` 是不是由 clock 擾動造成的。

## 解讀注意

- 每一筆 Replay 釋位分成四類（`detection` 欄位）：
  - `afterLastScan`：發生在該組合這一輪**最後一次開始抓取之後**，這一輪本來就看不到（下一輪才會偵測），不列入分母。
  - `reverted`：被偵測前就又翻回額滿，任何掃描都看不到。
  - `detected`：延遲 = 第一筆偵測時間 − 釋位時間，取 p50／p95。
  - `undetected`：可偵測（發生在該組最後一次開始抓取之前、沒有翻回）卻沒偵測到。**正常應該是 0**，可當正確性檢查。
  報告建議把實測延遲和推估值（最壞 T(n)、平均 T(n)/2）並列。
- `--repeat`：n=8 時一輪 360 則只要幾秒，會被 SQS 長輪詢、worker 啟動與尾端效應主導，speedup 會偏低。
  量 speedup 建議 `--repeat 10`（3,600 則）。同一組合在一輪內會被掃多次；契約 §5 提到「同組合兩個任務亂序提交」會產生一對來回的事件，
  這時偵測延遲以 `--repeat 1` 那一次的結果為準。
- Replay 的回應延遲（預設 500±250 ms，`--replay-delay-ms`）主導單次掃描時間；它是**假設值**，沒有用官網實測校準，報告要寫明。
  延遲越大，越接近「等網路」的 I/O bound，speedup 越接近線性；延遲設 0 則量到的是 worker＋RDS 的處理上限。
- Replay 站是單台 instance，8 台 worker × 5 並行 = 40 個同時請求；若 Replay 站本身 CPU 吃滿，speedup 會被它限制。
  量測時同時看 Replay instance 的 CloudWatch CPU。
- 釋位時間（Replay 的時鐘）和偵測時間（worker 的時鐘）來自不同主機，AL2023 預設用 chrony 對時，誤差在毫秒級，相對於秒級的延遲可忽略。
- Replay 的場次日期以重設當下的「台灣日期＋3 天」起算，不要跨午夜跑同一階。
