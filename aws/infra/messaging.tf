# SQS 掃描佇列（契約第 4 節）與 SNS 釋位事件 topic（契約第 6 節）。
# 名稱由契約固定，不加 project 前綴。

resource "aws_sqs_queue" "scan_dlq" {
  name                      = "mvdis-scan-dlq"
  message_retention_seconds = 1209600 # 14 天，方便事後檢查
}

resource "aws_sqs_queue" "scan" {
  name                       = "mvdis-scan"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 3600 # 契約 §4：1 小時；Learner Lab 停機期間的積壓不會在恢復後湧向官網
  receive_wait_time_seconds  = 20   # long polling

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.scan_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "scan_dlq" {
  queue_url = aws_sqs_queue.scan_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.scan.arn]
  })
}

resource "aws_sns_topic" "events" {
  name = "mvdis-events"
}

# CloudWatch alarm 的通知 topic（不是契約的一部分）
resource "aws_sns_topic" "alarms" {
  name = "${var.project}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count = var.alarm_email == null ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}
