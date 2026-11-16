# mvdis-watch on AWS（雲端運算期末專題）

把根目錄的 Cloudflare Workers 原型，重新設計成 AWS 上可擴展、高可用的分散式爬蟲。
原型繼續在 Cloudflare 上蒐集長期資料；這個資料夾是 AWS 版。

## 架構

```
EventBridge（每分鐘）→ Lambda dispatcher → SQS mvdis-scan（＋DLQ）
                                              ↓
              爬蟲 worker ASG（雙 AZ private subnet，依佇列積壓擴縮）
                 ├─ 經同 AZ 的 NAT Gateway 抓監理服務網（或 VPC 內的 Replay 模擬站）
                 ├─ 差異寫進 RDS PostgreSQL Multi-AZ
                 ├─ 原始頁面與事件寫進 S3 → Athena
                 └─ 釋位事件 → SNS → Lambda notifier → Discord
使用者 → CloudFront → ALB → API 服務 ASG（雙 AZ）→ RDS
管理者 → Bastion → private subnet
```

## 開發線

| 開發線 | 目錄 | 完成的定義 |
|---|---|---|
| infra | `infra/` | `terraform validate` 通過；一個 `terraform apply` 建出整套架構，`destroy` 能完整拆掉 |
| worker | `app/` | dispatcher、worker、notifier、migration；本機用 docker compose 跑通「派任務 → 抓 replay → 寫 DB → 發 SNS」 |
| api | `api/` | 原型的公開 JSON API 移植到 Postgres，加上儀表板頁 |
| replay | `replay/`、`experiments/` | Replay 模擬站、fixture 擷取；E1–E4 的實驗腳本與結果圖表產生器 |

各線之間的介面寫在 [CONTRACTS.md](CONTRACTS.md)，共用型別在 `shared/contracts.ts`，資料庫 schema 在 `db/schema.pg.sql`。

## 本機開發

```bash
docker compose -f aws/docker-compose.yml up -d
```

會起一個 Postgres（已套用 schema）和 LocalStack（SQS／SNS／S3／Secrets Manager）。

## 單機部署

拿到 AWS 帳號之前，可以先把整套（postgres、LocalStack、worker、api、replay、排程）跑在一台主機上，見 [deploy/single-host/README.md](deploy/single-host/README.md)。
