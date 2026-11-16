# 單機部署（docker compose）

把 AWS 版整套跑在一台主機上，用來在拿到 AWS Learner Lab 之前先驗證整條流程：
**dispatcher 派任務 → worker 抓頁面 → 寫 Postgres → 發事件 → api 讀出來**。
AWS 上的正式部署仍然用 [`aws/infra/`](../../infra/) 的 Terraform，這裡不取代它。

| AWS 版 | 單機版 |
|---|---|
| RDS PostgreSQL | `postgres:16-alpine`，資料在 named volume `pgdata` |
| SQS／SNS／S3／Secrets Manager | LocalStack 3.8（不保存狀態；重啟後由 [`aws/localstack/init/ready.d`](../../localstack/init/ready.d) 重建資源） |
| EventBridge（每分鐘／每日） | `scheduler` 容器：每分鐘呼叫 dispatcher（佇列有積壓時跳過），台灣時間 04:00 呼叫 janitor，04:10 清 `raw/` 與 `events/` |
| worker／api／replay ASG | 各一個容器，共用同一個映像 `mvdis-aws` |
| notifier Lambda（Discord） | **沒有接**。live 的 `released` 事件會照 filter policy 進 LocalStack 的 `mvdis-notify-local` 佇列 |
| CloudFront＋ALB | 沒有。api 只綁 `127.0.0.1:${API_PORT}`，用 SSH tunnel 看 |

和 AWS 版的差異只在部署層；程式碼完全相同（同一份 `dispatcher`、`janitor` handler、`worker.mjs`、`api.mjs`、`replay.mjs`）。

## 需求

- Docker Engine 與 Compose v2；amd64 或 arm64 都可以（Oracle A1 是 arm64）。
- 記憶體：各容器的 `mem_limit` 合計約 4 GB，實際用量通常遠低於此。
- 對外連線：worker 要能連 `https://www.mvdis.gov.tw`（live 任務）。不需要開任何對內的 port。

## 部署

先確認 port 沒被占用（主機上可能已有其他服務）：

```bash
ss -ltn | grep -w 8200 || echo "8200 可用"
```

被占用就在 `.env` 改 `API_PORT`。接著：

```bash
git clone https://github.com/ChiJiun/mvdis-watch.git && cd mvdis-watch
cd aws/deploy/single-host
cp .env.example .env && chmod 600 .env
# .env.example 的 change-me 只是占位字，一定要換掉
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
# 映像的 build context 是 repo 根目錄
docker build -f Dockerfile -t mvdis-aws:latest ../../..
docker compose up -d
docker compose ps
```

第一次啟動時 `.env` 是 `DISPATCH_ENABLED=0`，**不會打官網**。在主機上檢查：

```bash
curl -s http://127.0.0.1:8200/healthz
curl -s http://127.0.0.1:8200/api/meta
docker compose logs --tail=20 scheduler worker
```

確認沒問題（可以先跑下面「只用 Replay 模擬站驗證」），再開始抓官網：

```bash
sed -i "s/^DISPATCH_ENABLED=.*/DISPATCH_ENABLED=1/" .env
docker compose up -d scheduler
docker compose logs -f scheduler   # 每分鐘有 dispatcher 的 dispatched 和 scheduler 的 dispatch ok（sent 應為 14）
```

`DISPATCH_ENABLED` 只接受 `0` 或 `1`；其他值（例如 `true`）scheduler 會印出設定錯誤並結束，不會派送。
`.env` 裡寫成空值（`DISPATCH_ENABLED=`）時，compose 會把它當成未設定，帶入預設值 `0`（不派送）。

**佇列有積壓時不派送**：scheduler 每分鐘派送前會先查掃描佇列。
- 只要還有沒處理完的訊息（包括處理中的、以及 replay 實驗任務），或者查詢失敗，這一輪就跳過（log：`dispatch skipped: backlog`）。
- 佇列剛清空的那一輪，以及 scheduler 剛啟動的第一輪，也會跳過（log：`dispatch skipped: cooldown`），要連續兩輪都看到空佇列才派送。
- 原因：live 任務排隊 120 秒內都算新鮮。如果 worker 停了一陣子再恢復，積壓的任務和新派送的任務可能在幾秒內接連抓官網（實測 28 次）。
  照上面的規則，佇列裡最多只有一批，而且前後兩批之間至少隔 60 秒。正常運作時每批幾秒內就處理完，不受影響。

> **一台主機只能跑一份 scheduler。** 不要 `docker compose up --scale scheduler=2`，也不要在同一台主機用不同目錄或專案名稱再起一份這個 compose，否則每分鐘的官網請求會加倍。compose 已固定專案名稱為 `mvdis-watch`，在別的目錄執行 `docker compose up` 會接管同一組容器，不會另起一份。

從自己的電腦看儀表板（要公開給別人看，見下面的「公開儀表板」）：

```bash
ssh -N -L 8200:127.0.0.1:8200 <使用者>@<主機>
# 瀏覽器開 http://localhost:8200/
```

## 官網禮貌上限

`DISPATCH_ENABLED=1` 時，dispatcher 每分鐘會送 `HOT_PER_TICK + COLD_PER_TICK`（預設 11＋3＝14）個 **live** 任務，
worker 會實際查詢監理服務網。上限和保護規則與 AWS 版相同（契約 §4.2：過期、帶 runId 的 live 任務一律不抓）。

- **「每分鐘 14 次」以日曆分鐘計**：每個整分鐘最多派送一批，每個日曆分鐘的實際抓取不超過 14 次。
  一批 14 次會因 worker 併發（預設 5）和請求延遲，分散在整分鐘後的幾秒內完成，所以任意 60 秒的滑動視窗
  最多可能包含相鄰兩批（理論上限 28 次）；平均負載仍是每分鐘 14 次。這和契約 §4.1、Cloudflare 原型、AWS 版的 EventBridge 定義相同。
- scheduler 的 SQS 請求不自動重試：逾時的派送可能其實已經送達，重試會讓同一批進佇列兩次。失敗時由下一輪處理。
- **同一時間只能有一套系統在抓官網。** 根目錄的 Cloudflare 原型、AWS 版、這個單機版各自都會用滿每分鐘 14 次，
  同時開著就會加倍。部署 AWS 版（或啟用原型的 cron）之前，先把這裡的 `DISPATCH_ENABLED` 改成 `0`
  再 `docker compose up -d scheduler`。只用 `docker compose stop scheduler` 的話，下次 `docker compose up -d` 會把它重新啟動。
- 只想驗證流程、不打官網：維持 `.env` 的預設 `DISPATCH_ENABLED=0`，再用下面的方式灌 replay 任務。
- 要停止抓官網：把 `DISPATCH_ENABLED` 改回 `0`，再 `docker compose up -d scheduler`（佇列裡剩下的 live 任務 120 秒後會過期不抓）。

## live 轉發器（主機連不到官網時）

監理服務網會丟掉部分海外 IP 的連線（實測 Oracle 東京區域的 VM：IPv4 連線逾時，同一台主機連其他 gov.tw 網站正常）。
這時可以把 live 請求交給 [`live-proxy/`](live-proxy/) 這個 Cloudflare Worker 轉發：

- 只接受 `ALLOWED_IPS` 裡的來源 IP（部署時帶入，不寫進 repo）；沒設定就全部拒絕。
- 只轉發到官網的查詢端點（固定路徑），只允許 GET／POST，不轉送 cookie 與 query；連不到官網時回 502。
- 不另外限速：請求量仍由這裡的 scheduler 控制（每分鐘最多 14 則）。
  因此 `REPLAY_BASE_URL` 絕不能指向轉發器（replay 任務不受這個限制），同一台主機上也不要有其他程式呼叫它。
- VM 的公開 IP 變了就要用新 IP 重新 deploy。舊 IP 可能被分配給別人，在那之前對方也能使用轉發器；建議 VM 改用固定的公開 IP。
- `wrangler.toml` 設了 `placement.region = "gcp:asia-east1"`，讓 Worker 在台灣附近的節點發請求。
  沒設的話會在離 VM 最近的節點（東京）執行，實測每次要約 20 秒，會碰到 worker 的 20 秒抓取逾時；
  設了之後約 0.3 秒，回應標頭 `cf-placement: remote-TPE`。

```bash
# 在有安裝 wrangler 的電腦上（例如 repo 根目錄 npm ci 之後）
cd aws/deploy/single-host/live-proxy
npx wrangler login
npx wrangler deploy --var ALLOWED_IPS:<VM 的公開 IPv4>
# 在 VM 上確認轉發器連得到官網（會發 1 個請求，不在 scheduler 的每分鐘預算內，不要重複執行）
curl -s -o /dev/null -w "%{http_code}\n" https://mvdis-live-proxy.<子網域>.workers.dev/m3-emv-trn/exm/locations
```

確認回 200（而且很快）之後，在 VM 的 `.env` 設定 `MVDIS_LIVE_URL=https://mvdis-live-proxy.<子網域>.workers.dev`，
再 `docker compose up -d worker`。

> 手動測試時要注意：`docker compose stop worker` 之後，LocalStack 不會發現 worker 的長輪詢（20 秒）已經斷線，
> 這段時間送進佇列的訊息會被交給已經停掉的 worker，60 秒後才重新出現。停掉 worker 後至少等 30 秒再送測試任務。

> 注意：這等於讓 Cloudflare 代替海外主機向官網發請求。官網若明確禁止自動查詢或加上驗證機制，應停止使用（見提案的「不在範圍內」）。

## 公開儀表板（Cloudflare Tunnel，選用）

compose 裡的 `tunnel` 服務（profile `tunnel`，預設不啟動）會用 cloudflared 把 `api` 公開到你在 Cloudflare 上的網域。
只有主機往外連，不用開任何對內的 port，也不用改主機的防火牆。

需要一個由 Cloudflare 代管 DNS 的網域。以下在主機上執行，`<hostname>` 換成要用的網址（例如 `mvdis.example.com`）：

```bash
# cloudflared 映像以 uid 65532 執行，資料夾要給它寫入權限
sudo mkdir -p /opt/mvdis-cloudflared
sudo chown 65532:65532 /opt/mvdis-cloudflared && sudo chmod 700 /opt/mvdis-cloudflared
CF="docker run --rm -it -v /opt/mvdis-cloudflared:/home/nonroot/.cloudflared cloudflare/cloudflared:2026.10.2"

$CF tunnel login                              # 用瀏覽器開印出的網址，選網域並按「授權」，會寫入 cert.pem
$CF tunnel create mvdis-watch                 # 印出 tunnel id，並寫入 <tunnel id>.json（Tunnel 的憑證）
$CF tunnel route dns mvdis-watch <hostname>   # 建立指向這個 Tunnel 的 CNAME
```

接著寫 `/opt/mvdis-cloudflared/config.yml`（`<tunnel id>` 換成上面印出的 id）：

```yaml
tunnel: <tunnel id>
credentials-file: /home/nonroot/.cloudflared/<tunnel id>.json
ingress:
  - hostname: <hostname>
    service: http://api:8080
  - service: http_status:404
```

```bash
sudo chown 65532:65532 /opt/mvdis-cloudflared/config.yml
# 在 .env 加上 COMPOSE_PROFILES=tunnel（之後一般的 docker compose up -d／down 都會包含它）
echo 'COMPOSE_PROFILES=tunnel' >> .env
docker compose up -d tunnel
docker compose logs tunnel | grep Registered   # 應該有 4 條 Registered tunnel connection
```

- `cert.pem` 可以管理這個網域底下的 Tunnel 和 DNS，`<tunnel id>.json` 可以冒用這條 Tunnel，兩個都不要外流，也不要進 repo。
- 公開之後任何人都能看儀表板、呼叫 `/api/*`。API 是唯讀的，但沒有限速；負載在這台主機的 api 和 Postgres 上。要限制誰能看，請在 Cloudflare Zero Trust 為這個網址加一個 Access 應用程式。
- 停用：`docker compose stop tunnel`，並把 `.env` 的 `COMPOSE_PROFILES=tunnel` 拿掉。

## 只用 Replay 模擬站驗證（不打官網）

```bash
# 送一則 target=replay 的任務（taskId 必須是 UUID）
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/mvdis-scan \
  --message-body "{\"v\":1,\"taskId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"licenseType\":\"3\",\"lv1\":\"60\",\"dmvNo\":\"63\",\"tier\":\"hot\",\"target\":\"replay\",\"runId\":\"manual\",\"enqueuedAt\":$(date +%s000)}"

# replay 的資料只會進 replay schema（契約 §7.3），公開 API 看不到
docker compose exec postgres psql -U mvdis -d mvdis -c \
  "SELECT target, outcome, count(*) FROM scan_task_log GROUP BY 1,2;" -c \
  "SELECT count(*) FROM replay.slot;"
```

大量實驗請用 [`aws/experiments/`](../../experiments/) 的腳本。

## 維運

- **schema 變更**：Postgres 只在 volume 第一次建立時套用 `schema.pg.sql`。之後要更新，在 repo 根目錄的 `aws/app` 執行
  `DATABASE_URL=postgres://mvdis:<密碼>@127.0.0.1:5432/mvdis npm run migrate`（需要先暫時把 postgres 的 5432 映射到 127.0.0.1），
  或用 `docker compose exec -T postgres psql -U mvdis -d mvdis < ../../db/schema.pg.sql`（schema 檔是可重複套用的）。
- **更新程式**：`git pull`、重新 `docker build`，再 `docker compose up -d`。
- **要停 worker 做維護**：先停 scheduler（`docker compose stop scheduler`，或把 `DISPATCH_ENABLED` 改成 `0`），再停 worker。
  恢復時順序相反：先起 worker，等佇列清空，再起 scheduler。scheduler 雖然會在有積壓時暫停派送，照這個順序可以連那一批都不累積。
- **LocalStack 重啟**：佇列裡還沒處理的任務會消失（live 任務本來就 120 秒過期），raw/ 物件也會消失；DB 不受影響。
- **磁碟**：每個容器的 log 上限 30 MB（10 MB × 3）。
- **停止**：`docker compose down`（保留資料）；`docker compose down -v` 會**刪掉資料庫 volume**。

## 沒有涵蓋的部分

- Discord 推播：notifier 是 Lambda handler，單機版沒有 SNS → Lambda 的觸發。需要時可以另寫一個輪詢 `mvdis-notify-local` 的小程式呼叫同一個 handler。
- HTTPS 與對外開放：主機本身不開 port，也不處理 HTTPS。要公開請用上面「公開儀表板」的 Cloudflare Tunnel。
- 高可用、擴展與 CloudWatch 指標：這些是 AWS 版要量測的對象（E1–E4），單機版只驗證功能。
