#!/bin/bash
# LocalStack 啟動完成後建立本機開發用的 AWS 資源，名稱對應 aws/CONTRACTS.md。
# 由 aws/docker-compose.yml 掛到 /etc/localstack/init/ready.d，每次容器啟動都會跑（LocalStack 預設不保存狀態）。
#
# 建好之後本機各服務可用的環境變數：
#   AWS_ENDPOINT_URL=http://localhost:4566  AWS_REGION=us-east-1
#   SCAN_QUEUE_URL=http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/mvdis-scan
#   EVENT_TOPIC_ARN=arn:aws:sns:us-east-1:000000000000:mvdis-events
#   RAW_BUCKET=mvdis-raw-local
#   DISCORD_SECRET_ARN=mvdis/discord   DB_SECRET_ARN=mvdis/db
set -euo pipefail

REGION=us-east-1

# SQS：掃描佇列（可見性 60 秒、保留 1 小時、3 次後進 DLQ）
awslocal sqs create-queue --region "$REGION" --queue-name mvdis-scan-dlq >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" \
  --queue-url "$(awslocal sqs get-queue-url --region "$REGION" --queue-name mvdis-scan-dlq --output text --query QueueUrl)" \
  --attribute-names QueueArn --output text --query Attributes.QueueArn)
awslocal sqs create-queue --region "$REGION" --queue-name mvdis-scan --attributes "{
  \"VisibilityTimeout\": \"60\",
  \"MessageRetentionPeriod\": \"3600\",
  \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
}" >/dev/null

# SNS：釋位事件 topic
TOPIC_ARN=$(awslocal sns create-topic --region "$REGION" --name mvdis-events --output text --query TopicArn)

# 本機沒有 notifier Lambda；建一個用同樣 filter policy 訂閱的 SQS，方便觀察「會推播」的事件
awslocal sqs create-queue --region "$REGION" --queue-name mvdis-notify-local >/dev/null
NOTIFY_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" \
  --queue-url "$(awslocal sqs get-queue-url --region "$REGION" --queue-name mvdis-notify-local --output text --query QueueUrl)" \
  --attribute-names QueueArn --output text --query Attributes.QueueArn)
awslocal sns subscribe --region "$REGION" --topic-arn "$TOPIC_ARN" --protocol sqs \
  --notification-endpoint "$NOTIFY_ARN" \
  --attributes '{"FilterPolicy":"{\"target\":[\"live\"]}"}' >/dev/null

# S3：資料湖
awslocal s3api create-bucket --region "$REGION" --bucket mvdis-raw-local >/dev/null 2>&1 || true

# Secrets Manager：Discord webhook（預設是無效位址，要實際推播時用 DISCORD_WEBHOOK_URL 覆寫）與 DB 帳密
awslocal secretsmanager create-secret --region "$REGION" --name mvdis/discord \
  --secret-string "{\"webhookUrl\":\"${DISCORD_WEBHOOK_URL:-http://127.0.0.1:9/discord-disabled}\"}" >/dev/null 2>&1 || true
awslocal secretsmanager create-secret --region "$REGION" --name mvdis/db \
  --secret-string '{"username":"mvdis","password":"mvdis"}' >/dev/null 2>&1 || true

echo "[mvdis] LocalStack 資源就緒：mvdis-scan(+dlq)、mvdis-events、mvdis-notify-local、mvdis-raw-local、mvdis/discord、mvdis/db"
