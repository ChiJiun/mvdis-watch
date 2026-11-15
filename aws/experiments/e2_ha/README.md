# E2 高可用

掃描進行中，終止 AZ-a 內 worker ASG 與 API ASG 的所有 instance，並觸發 RDS reboot with failover，量：

| 指標 | 定義 | 目標 |
|---|---|---|
| API 中斷秒數 | 每秒 `GET <cloudfront>/healthz?_cb=<隨機>`（逾時 3 秒），最長連續失敗區間與失敗總秒數 | 越短越好 |
| DB 中斷秒數 | 每秒新開連線跑 `SELECT 1`（逾時 3 秒；新連線才看得到 DNS 切換） | ≈ RDS 切換時間 |
| RDS 切換時間 | RDS 事件「Multi-AZ instance failover started → completed」的時間差；另記從 reboot 到回到 available 的秒數與主節點 AZ 變化 | 文件值約 60–120 秒 |
| 漏掃組數 | 這個 runId 的 360 組中，沒有任何一筆 `outcome='ok'` 的組數 | **0** |
| 重送數 | `scan_task_log.receive_count > 1` 的任務數（被終止的 worker 手上的訊息） | — |
| 掃描管線最長停擺 | 故障後 `finished_at` 相鄰兩筆的最大間隔 | — |
| 各 AZ 分工 | `scan_task_log.az` 統計，確認故障後由 AZ-b 接手 | — |

## 需要的 AWS 輸出值

`scan_queue_url`、`worker_asg_name`、`api_asg_name`、`cloudfront_url`、`rds_identifier`、`replay_base_url`，
以及讀 `scan_task_log` 的資料庫設定（`rds_endpoint`、`rds_port`、`db_name`、`db_secret_arn`）。

## 前置條件

- RDS 必須是 Multi-AZ（腳本會檢查，不是就停止）。
- 兩個 ASG 在 AZ-a、AZ-b 都要有 instance：infra 的 `worker_min_size` 預設是 1，E2 前改成 2；
  AZ-a 一台都沒有時腳本會停止（測不到 AZ 故障）。
- 暫停 dispatcher 排程（上層 README），避免排程任務混進來。
- **Replay 站目前固定在 AZ-a**（infra `aws_instance.replay`），但它不屬於任何 ASG，腳本只終止 ASG 的 instance，所以 Replay 不會被關掉。
  這和「整個 AZ 掛掉」不完全一樣：真實 AZ 故障時 Replay（代表外部的官網）也會不見，但官網本來就不在我們的 AZ 裡，所以保留它是合理的簡化，報告裡要寫明。
- NAT Gateway 是 AWS 託管服務，終止 instance 不會影響它；真實 AZ 故障時 AZ-a 的 NAT 也會失效，這部分不在本實驗範圍。

## 步驟

```bash
python e2_ha/fault_inject.py --dry-run                            # 先看步驟與會影響的資源
python e2_ha/fault_inject.py --tf-outputs outputs.json --az us-east-1a --confirm
```

腳本流程：

1. 前置檢查 RDS Multi-AZ／available，列出故障 AZ 內兩個 ASG 的 instance
2. Replay 回應延遲調成 5 秒（`--replay-delay-ms`），讓一輪 360 組要跑好幾分鐘，故障才會落在掃描進行中
3. 灌 360 個 `target=replay` 任務，啟動 API／DB 探針
4. `--fault-after`（預設 30）秒後，`ec2:TerminateInstances` 終止故障 AZ 內的所有 ASG instance
   （刻意不用 ASG 的 `TerminateInstanceInAutoScalingGroup`，那是「有禮貌的」縮容，不像故障）
5. 同時（`--rds-after` 秒後）`rds:RebootDBInstance(ForceFailover=True)`，每 2 秒輪詢狀態並讀 RDS 事件
6. 等這個 runId 全部完成（RDS 切換期間會自動重連），再讓探針多跑 `--post-seconds` 秒
7. 還原 Replay 延遲（與 `--block-az` 時的 ASG subnet），寫 `results/e2/<runId>.json`

選項：

- `--block-az`：實驗期間把故障 AZ 的 subnet 從兩個 ASG 的 `VPCZoneIdentifier` 移除，ASG 補機只會補在 AZ-b，
  比較接近「整個 AZ 不能用」；結束後（含例外）會還原。不加的話，ASG 可能把替補的 instance 又開在 AZ-a。
- `--no-rds`：只測 instance 故障。
- 回傳碼：漏掃組數為 0 回 0，否則回 2。

## 預期觀察

被終止的 worker 手上的訊息要等 SQS 可見性逾時（60 秒）才會重新出現、由 AZ-b 的 worker 接手，
所以這一輪的完成時間至少多 60 秒，`redelivered` 會大於 0，但漏掃組數應該是 0（契約第 5 節的冪等設計）。
RDS 切換期間 worker 寫入會失敗，訊息同樣靠重送補上；API 期間的 `/healthz` 若不查資料庫，API 中斷只反映 instance 被終止。
