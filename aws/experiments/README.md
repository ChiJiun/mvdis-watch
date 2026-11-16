# E1–E4 實驗腳本

提案承諾的四個實驗。每個實驗一個子資料夾，各自有 README 寫步驟、需要的 AWS 輸出值與量測項目。

| 實驗 | 資料夾 | 量測 |
|---|---|---|
| E1 擴展性 | [e1_scalability/](e1_scalability/README.md) | Locust 50→2,000 併發的 p95、API ASG 台數；3,600 個掃描任務的佇列清空時間、worker ASG 台數 |
| E2 高可用 | [e2_ha/](e2_ha/README.md) | 終止 AZ-a 所有 instance＋RDS 強制切換：服務中斷秒數、漏掃組數（目標 0）、RDS 切換時間 |
| E3 效能 | [e3_performance/](e3_performance/README.md) | 1/2/4/8 台 worker 掃完 360 組的耗時、speedup、偵測延遲 |
| E4 成本 | [e4_cost/](e4_cost/README.md) | Cloudflare 免費方案 vs EC2 ASG vs Lambda 的每千次掃描成本與月成本 |
| 出圖 | [plot/](plot/plot_results.py) | 把 `results/` 的結果畫成報告用的 PNG |

## 共同原則

- **對官網的請求率維持每分鐘 14 次。** 所有高頻實驗只打 VPC 內的 Replay 模擬站（`aws/replay/`）。
- **實驗灌入的任務一律 `target=replay`。** `common/tasks.py` 的 `assert_replay()` 在送進 SQS 前逐則檢查，
  腳本沒有任何參數可以送 `target=live`；runId 也必須有值。
- 每支會碰 AWS 的腳本都有 `--dry-run`：不 import boto3／psycopg、不需要憑證、不連網，只印出步驟並寫一份標記 `dryRun: true` 的結果檔。
- E2 會真的終止 instance 並切換 RDS，實跑必須多加 `--confirm`。
- 結果寫在 `results/<實驗>/<runId>.json`（不進 git）；出圖腳本預設略過 `dryRun` 的結果，避免把假資料放進報告。

## 執行環境

RDS 和 Replay 站都在 private subnet。**執行 E1 佇列端（`--watch` 讀資料庫時）、E2、E3 的主機必須同時連得到：**

| 目標 | 位址 | 用途 |
|---|---|---|
| RDS | `rds_endpoint`:5432 | 讀 `public.scan_task_log`、`replay.slot_event`，清空 replay schema |
| Replay 站 | `replay_base_url`（`http://10.0.10.200:8080`） | `/admin/reset`、`/admin/stats`、`/admin/events` |
| AWS API | SQS、Auto Scaling、EC2、RDS、Secrets Manager（經 NAT） | 送任務、調整 ASG、故障注入、讀帳密 |

預定的實驗主機是 **bastion**，但 `main` 目前的 infra（PR #6）**不允許** bastion 連這兩個位址：

- RDS-SG 只收 API-SG、Worker-SG 的 5432（`aws/infra/security_groups.tf` 的 `rds_from_app`）。
- Replay-SG 只收 Worker-SG 的 8080（`replay_from_worker`）。

所以要先等 infra 的後續 PR 補上兩條 ingress 規則，bastion 才能當實驗主機：

- `rds_from_bastion`：RDS-SG 收 Bastion-SG 的 5432。
- `replay_from_bastion`：Replay-SG 收 Bastion-SG 的 8080。

規則上線前在 bastion 上跑，E1（`--watch`／`--truncate-replay-db`）、E2、E3 會在第一次連資料庫或 Replay 時逾時停止
（E1、E2 停在任何破壞性動作之前；E3 若已把 worker ASG 釘住台數，會由 `finally` 還原）。也不能改用 worker 當跳板（`ssh -J bastion -L … <worker>`）：
E2 會終止 AZ-a 的 worker、E3 會把 worker ASG 縮到 1 台，跳板所在的 worker 可能在實驗中被關掉。

E1 的 Locust 只打公開的 CloudFront，不需要上面的規則；建議另開一台 `t3.large` 以上的 EC2（2,000 個使用者單機會吃滿 CPU，
加 `--processes -1` 用滿所有核心）。E4 是純計算，哪裡都能跑。

```bash
# bastion（Amazon Linux 2023）上
sudo dnf install -y python3.11 python3.11-pip git nodejs22 google-noto-sans-cjk-ttc-fonts
git clone <repo> && cd mvdis-watch/aws/experiments
python3.11 -m pip install --user -r requirements.txt
```

憑證：Learner Lab 的 bastion 掛 `LabInstanceProfile`，boto3 會自動取得；在自己電腦上跑則把 Learner Lab 的
AWS Details 貼到 `~/.aws/credentials`（約 4 小時過期）。

## 需要的 AWS 輸出值

在 `aws/infra` 執行 `terraform output -json > ../experiments/outputs.json`，各腳本加 `--tf-outputs outputs.json`
就會自動帶入；也可以用環境變數或命令列參數覆寫（優先序：命令列 > 環境變數 > outputs.json）。

| 設定 | 環境變數 | terraform output | 用在 |
|---|---|---|---|
| SQS 掃描佇列 | `SCAN_QUEUE_URL` | `scan_queue_url` | E1、E2、E3 |
| worker ASG | `WORKER_ASG_NAME` | `worker_asg_name` | E1、E2、E3 |
| API ASG | `API_ASG_NAME` | `api_asg_name` | E1、E2 |
| 公開 API 入口 | `API_BASE_URL` | `cloudfront_url` | E1、E2（ALB 只收 CloudFront 帶 `X-Origin-Verify` 的請求，所以一律打 CloudFront） |
| RDS identifier | `RDS_IDENTIFIER` | `rds_identifier` | E2 |
| Replay 站 | `REPLAY_BASE_URL` | `replay_base_url` | E2、E3 |
| 資料庫 | `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_SECRET_ARN`（或 `DATABASE_URL`） | `rds_endpoint`、`rds_port`、`db_name`、`db_secret_arn` | E1、E2、E3 讀 `public.scan_task_log`（`target='replay'`）、E3 讀 `replay.slot_event`；實驗前清空 replay schema |

## 實驗資料隔離（契約 §7.3）

worker 處理 `target=replay` 任務時，`slot`／`slot_event`／`scan_log` 寫進 **`replay` schema**，和正式資料（`public`）完全分開：

- 實驗期間公開 API／儀表板只讀 `public`，看不到 Replay 的假場次；`lastTick` 也不會被實驗推進。
- 實驗結束、恢復 dispatcher 之後，live 掃描拿來比對的是 `public.slot`，不會碰到 Replay 寫的狀態，所以不會產生假的 `released`
  推到 Discord（notifier 的 SNS filter 只收 `target=live` 是第二層保護）。
- 實驗腳本讀的表：任務量測讀 `public.scan_task_log WHERE target = 'replay'`；E3 的偵測紀錄讀 `replay.slot_event`。
  腳本裡沒有任何 SQL 碰 `public` 的 `slot`／`slot_event`／`scan_log`（單元測試會檢查）。
- **實驗前清空 replay schema**：E2、E3（每一階暖身前）會先執行
  `TRUNCATE replay.slot, replay.slot_event, replay.scan_log RESTART IDENTITY`，讓每次實驗都從空的 replay 狀態開始；
  不想清空時加 `--keep-replay-db`。E1 不讀 replay 表，預設**不清**（避免清掉同時在跑的 E3 資料），需要時加 `--truncate-replay-db`。
  TRUNCATE 前會設 `lock_timeout`（30 秒），若 worker 還握著 replay 表的鎖會直接報錯，不會無限等待。只清 replay schema，`public` 與 `scan_task_log` 都不動（scan_task_log 靠 runId 區分）。
  手動清空：`psql "$DATABASE_URL" -c 'TRUNCATE replay.slot, replay.slot_event, replay.scan_log RESTART IDENTITY'`。

## 實驗前的 infra 設定

實驗需要 infra 用下列變數重新 `terraform apply`（這些是 infra 線的變數，不是這裡的設定）：

- `replay_enabled = true`：建立 Replay 站（預設關閉）。
- worker 的環境變數 `REPLAY_BASE_URL` 要設成 `replay_base_url`（契約 §3；infra 對應的 Terraform 變數名稱以 infra README 為準）。
  worker 收到 replay 任務時只打這個位址；未設定、或指向 `mvdis.gov.tw` 時，worker 會把任務記成 `rejected`（契約 §4.2），
  這時實驗結果的 `scanTaskLog.rejected` 會大於 0、漏掃組數等於 360。
- E2 前：`worker_min_size = 2`（預設 1），確保兩個 AZ 各有 worker；API ASG 同理。
- E3 跑到 8 台：`worker_max_size >= 8`（預設就是 8）。
- Replay 站的 `/admin/*` 預設不驗證身分，靠 security group 隔離：Replay-SG 目前只開放 Worker-SG（`replay_from_worker`），
  infra 後續 PR 會再加 Bastion-SG（`replay_from_bastion`），之後就只有 Worker-SG 和 Bastion-SG 連得到。
  若要再加一層，可以在 Replay 站設定 `REPLAY_ADMIN_TOKEN`，並在執行實驗的主機設定同名環境變數：
  `common/replay_admin.py` 會自動帶上 `x-admin-token` 標頭。

量測期間暫停每分鐘的排程（否則 dispatcher 送的任務會和實驗任務搶 worker），結束後恢復。
因為 replay 資料在獨立的 schema，恢復排程不需要額外清理正式資料：

```bash
aws events disable-rule --name mvdis-dispatch-every-minute
aws events enable-rule  --name mvdis-dispatch-every-minute
```

## 測試

```bash
cd aws/experiments
python -m unittest discover -s tests -v     # 不需要 AWS、boto3、psycopg、locust
python plot/plot_results.py --demo          # 用合成資料畫一次，確認出圖流程（輸出到 results/figures/demo/）
```

`common/combos.json` 由 `node --experimental-strip-types common/gen_combos.ts` 從原型 `src/catalogue.ts` 產生，
測試會檢查兩者同步。
