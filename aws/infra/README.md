# aws/infra — Terraform

用一個 `terraform apply` 在 AWS Academy Learner Lab 建出整套 mvdis-watch AWS 架構，`terraform destroy` 全部拆掉。
介面（佇列名稱、環境變數、產物路徑）以 [`../CONTRACTS.md`](../CONTRACTS.md) 為準。

## 架構對照

| 檔案 | 內容 |
|---|---|
| `network.tf` | VPC 10.0.0.0/16、雙 AZ 的 public／app／data subnet、每 AZ 一個 NAT Gateway、S3 Gateway Endpoint |
| `security_groups.tf` | 鏈式 SG：ALB ← CloudFront prefix list、API ← ALB、RDS ← API／Worker、Replay ← Worker、22 只收 Bastion |
| `compute.tf` | worker ASG（SQS 積壓 target tracking）、API ASG（CPU target tracking）、Bastion、Replay（可選） |
| `templates/user_data.sh.tftpl` | 裝 nodejs22、從 S3 抓 `releases/<name>.mjs`、systemd 執行、CloudWatch agent 收 log |
| `edge.tf` | ALB（只放行帶 `X-Origin-Verify` 的請求）＋ CloudFront（遵守 origin 的 Cache-Control） |
| `messaging.tf` | SQS `mvdis-scan`（保留 1 小時）＋`mvdis-scan-dlq`、SNS `mvdis-events`、alarm topic |
| `lambda.tf` | `mvdis-dispatcher`（EventBridge 每分鐘）、`mvdis-notifier`（SNS filter `target=live`）、`mvdis-janitor`（每日台灣 04:00，VPC 內、Worker-SG） |
| `database.tf` | RDS PostgreSQL 16 Multi-AZ、Secrets Manager（DB 帳密、Discord webhook 空殼） |
| `storage.tf` | artifact bucket、資料湖 bucket、Glue `events` 表（dt partition projection）、Athena workgroup |
| `monitoring.tf` | alarm：DLQ 有訊息、RDS CPU、worker ScanErrors |
| `outputs.tf` | CloudFront 網址、ALB DNS、Bastion IP、佇列 URL、RDS endpoint… |

Learner Lab 不能建 IAM role／policy，這裡**沒有任何 `aws_iam_role`**：EC2 用 `LabInstanceProfile`，Lambda 用 `LabRole`（data source 取 ARN）。

## 1. 準備

### 安裝 Terraform（≥ 1.6）

```bash
winget install Hashicorp.Terraform
```

或用 Docker（不必安裝）：

```bash
docker run --rm -it -v "$PWD:/work" -w /work/aws/infra -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e AWS_REGION=us-east-1 hashicorp/terraform:1.9 plan
```

### 取得 Learner Lab 臨時憑證

1. 進 AWS Academy → Learner Lab → **Start Lab**，等左上角燈號變綠。
2. 按 **AWS Details** → **AWS CLI: Show**，複製三行 `aws_access_key_id`／`aws_secret_access_key`／`aws_session_token`。
3. 貼到 `~/.aws/credentials` 的 `[default]`（或設成環境變數 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`AWS_SESSION_TOKEN`）。
4. 同一頁下載 **PEM**（`labsuser.pem`），這是 key pair `vockey` 的私鑰，SSH 進 Bastion 用。

憑證大約 **4 小時**過期，過期後重做第 2–3 步。Session 結束時 EC2 會被停掉、RDS 也可能停，下次 Start Lab 後跑一次 `terraform apply` 讓狀態對齊（Bastion IP 會變）。

### 先打包各服務（可選，但沒打包就只有骨架）

Terraform 會自動找下列檔案（契約第 2 節），**有就部署、沒有就跳過**：

| 產物 | 沒打包時 |
|---|---|
| `aws/app/dist/dispatcher.zip` | Lambda 用佔位程式，EventBridge 排程自動停用 |
| `aws/app/dist/notifier.zip` | Lambda 用佔位程式（收到事件會報錯） |
| `aws/app/dist/janitor.zip` | Lambda 用佔位程式，每日排程自動停用 |
| `aws/app/dist/worker.mjs`、`aws/api/dist/api.mjs`、`aws/replay/dist/replay.mjs` | 不上傳；instance 上的 systemd 每 10 秒重試下載，直到檔案出現在 `s3://<artifact_bucket>/releases/` |

打包完再跑一次 `terraform apply`：Lambda 會換成新程式碼；EC2 產物內容改變時 launch template 出新版本，ASG 依 `instance_refresh` 滾動替換 instance。

## 2. 部署

```bash
cd aws/infra
cp terraform.tfvars.example terraform.tfvars   # 填 admin_cidr（你的 IP/32）
terraform init
terraform plan
terraform apply
```

全新建立約 15–25 分鐘（RDS Multi-AZ 與 CloudFront 最久）。

### 部署後要手動做的事

1. **Discord webhook**：Terraform 只建空殼 secret，值要自己填：
   ```bash
   aws secretsmanager put-secret-value --secret-id "$(terraform output -raw discord_secret_arn)" --secret-string '{"webhookUrl":"https://discord.com/api/webhooks/..."}'
   ```
2. **資料庫 migration**：RDS-SG 只收 API-SG 與 Worker-SG，所以從 worker instance 轉 tunnel（流量從 worker 出發）：
   ```bash
   ssh -i labsuser.pem -J ec2-user@<bastion_public_ip> -L 5432:<rds_endpoint>:5432 ec2-user@<worker private IP>
   ```
   另開終端機，用 `aws secretsmanager get-secret-value --secret-id <db_secret_arn>` 取得密碼，`DATABASE_URL=postgres://mvdis:<密碼>@localhost:5432/mvdis` 跑 `aws/app` 的 `npm run migrate`。
3. **alarm 通知**（可選）：設了 `alarm_email` 的話，到信箱點 SNS 的確認信。

### 驗證

```bash
curl "$(terraform output -raw cloudfront_url)/healthz"
aws sqs get-queue-attributes --queue-url "$(terraform output -raw scan_queue_url)" --attribute-names ApproximateNumberOfMessages
```

instance 的 log 在 CloudWatch Logs `/mvdis/worker`、`/mvdis/api`、`/mvdis/replay`；Lambda 在 `/aws/lambda/mvdis-*`。

Athena：workgroup 選 `mvdis`，例如
```sql
SELECT kind, count(*) FROM mvdis_datalake.events WHERE dt >= '2026-11-01' GROUP BY kind;
```
`dt` 是**台灣時間**的日期（契約 §5）。

## 3. 實驗相關

- **E2 高可用**：`terraform output private_subnet_ids` 找出 AZ-a，停掉該 AZ 的 instance；RDS 用 `aws rds reboot-db-instance --db-instance-identifier "$(terraform output -raw rds_identifier)" --force-failover`。
- **E3 speedup**：`terraform.tfvars` 設 `replay_enabled = true` 後 apply：建立 Replay 站，worker 的環境變數多一個 `REPLAY_BASE_URL=http://10.0.10.200:8080`（launch template 變更會滾動替換 worker）。`MVDIS_LIVE_URL` 固定是官網，不能改；replay 任務只會打 `REPLAY_BASE_URL`（契約 §4.2）。固定台數時先暫停擴縮，避免 target tracking 干擾：
  ```bash
  aws autoscaling suspend-processes --auto-scaling-group-name mvdis-worker-asg --scaling-processes AlarmNotification
  aws autoscaling set-desired-capacity --auto-scaling-group-name mvdis-worker-asg --desired-capacity 4
  ```
  `desired_capacity` 在 Terraform 裡設為 `ignore_changes`，之後 apply 不會蓋回去。
- dispatcher 一律只送 live 任務（每分鐘 ≤ 14 則），replay 任務由實驗腳本直接灌佇列。實驗期間不想混入 live 任務時設 `dispatcher_schedule_enabled = false`。

> ⚠️ Learner Lab 對同時執行的 instance 數量與 instance 類型有限制（請以 Lab 的 Readme 為準）。全開時是 Bastion 1 + API 2 + worker 最多 8 + Replay 1 = 12 台；若超過上限，E3 跑 8 台 worker 時可暫時把 `api_min_size` 降為 1。

## 4. 拆除

```bash
terraform destroy
```

`mvdis-janitor` 在 VPC 內，AWS 釋放 Lambda 的網路介面（ENI）要一段時間，destroy 時 Worker-SG 與 app subnet 可能卡 10–20 分鐘才刪掉，屬正常現象。

S3 bucket 設了 `force_destroy`、Secrets Manager 的 `recovery_window_in_days = 0`、RDS `skip_final_snapshot`，所以 destroy 後可以立刻用同樣名稱重建。**RDS 的資料會一起消失**（契約第 10 節：DB 不是唯一來源，原始資料在 S3 也會被刪，需要的話先 `aws s3 sync` 下來）。

## 5. 主要變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `admin_cidr` | （必填） | SSH 來源，不能是 0.0.0.0/0 |
| `key_name` | `vockey` | EC2 key pair |
| `db_multi_az` | `true` | RDS Multi-AZ |
| `worker_min_size`／`worker_max_size` | 1／8 | worker ASG |
| `worker_backlog_per_instance_target` | 50 | 每台 worker 的目標積壓訊息數 |
| `api_min_size`／`api_max_size` | 2／6 | API ASG |
| `replay_enabled` | `false` | 是否建 Replay 站；開啟時 worker 才有 `REPLAY_BASE_URL` |
| `hot_per_tick`、`cold_per_tick` | 11、3 | dispatcher；hot+cold ≤ 14（plan 時檢查） |
| `dispatcher_schedule_enabled` | `true` | dispatcher 每分鐘排程開關 |
| `janitor_schedule_enabled` | `true` | janitor 每日排程開關 |

完整清單見 `variables.tf`。
