# CloudWatch alarm：DLQ 有訊息、RDS CPU 偏高、worker 掃描錯誤數偏高。
# 通知送到 SNS topic ${var.project}-alarms（設定 alarm_email 才會寄信）。

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.project}-scan-dlq-not-empty"
  alarm_description   = "mvdis-scan-dlq 有訊息：有任務重試 3 次仍失敗"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.scan_dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.project}-rds-cpu-high"
  alarm_description   = "RDS CPU 連續 15 分鐘超過 ${var.rds_cpu_alarm_threshold}%"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.rds_cpu_alarm_threshold
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# 契約第 9 節：worker 以 EMF 寫 MvdisWatch/ScanErrors，維度 Tier、Target。
# alarm 不支援 SEARCH，所以把 live 的 hot、cold 兩條指標加總（實驗的 replay 錯誤不告警）。
resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${var.project}-worker-scan-errors"
  alarm_description   = "5 分鐘內 live 掃描錯誤數超過 ${var.worker_error_alarm_threshold}"
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = var.worker_error_alarm_threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "errors"
    expression  = "FILL(hot, 0) + FILL(cold, 0)"
    label       = "live ScanErrors"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = toset(["hot", "cold"])

    content {
      id          = metric_query.value
      return_data = false

      metric {
        namespace   = "MvdisWatch"
        metric_name = "ScanErrors"
        stat        = "Sum"
        period      = 300
        dimensions = {
          Tier   = metric_query.value
          Target = "live"
        }
      }
    }
  }
}
