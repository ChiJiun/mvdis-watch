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

RDS 和 Replay 站都在 private subnet，**E1 佇列端、E2、E3 要在 bastion（VPC 內）上跑**；E1 的 Locust 建議另開一台
`t3.large` 以上的 EC2（2,000 個使用者單機會吃滿 CPU，加 `--processes -1` 用滿所有核心）；E4 是純計算，哪裡都能跑。

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
| 資料庫 | `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_SECRET_ARN`（或 `DATABASE_URL`） | `rds_endpoint`、`rds_port`、`db_name`、`db_secret_arn` | E1、E2、E3 讀 `scan_task_log` |

## 實驗前的 infra 設定

實驗需要 infra 用下列變數重新 `terraform apply`（這些是 infra 線的變數，不是這裡的設定）：

- `replay_enabled = true`：建立 Replay 站（預設關閉）。
- worker 的環境變數 `REPLAY_BASE_URL` 要設成 `replay_base_url`（契約 §3；infra 對應的 Terraform 變數名稱以 infra README 為準）。
  worker 收到 replay 任務時只打這個位址；未設定、或指向 `mvdis.gov.tw` 時，worker 會把任務記成 `rejected`（契約 §4.2），
  這時實驗結果的 `scanTaskLog.rejected` 會大於 0、漏掃組數等於 360。
- E2 前：`worker_min_size = 2`（預設 1），確保兩個 AZ 各有 worker；API ASG 同理。
- E3 跑到 8 台：`worker_max_size >= 8`（預設就是 8）。

量測期間暫停每分鐘的排程（否則 dispatcher 送的任務會和實驗任務搶 worker），結束後恢復：

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
