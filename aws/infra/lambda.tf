# dispatcher（EventBridge 每分鐘觸發 → 送 SQS）、notifier（SNS → Discord）、janitor（每日清理 DB）。
# dispatcher、notifier 不放 VPC：dispatcher 無狀態不連 DB（契約 §4.1），notifier 只連 Secrets Manager 與 Discord。
# janitor 要連 RDS，放 private 應用層、套 Worker-SG（契約 §2）。
# 一律用 Learner Lab 的 LabRole。

# 打包產物還沒出來時用的佔位程式，讓 plan/apply 不會因為缺檔失敗。
data "archive_file" "lambda_placeholder" {
  type        = "zip"
  output_path = "${path.module}/.build/lambda-placeholder.zip"

  source {
    filename = "index.mjs"
    content  = "export const handler = async () => { throw new Error('placeholder: run the aws/app build and terraform apply again'); };\n"
  }
}

locals {
  lambda_built = { for name, path in local.lambda_artifacts : name => fileexists(path) }

  lambda_zip = {
    for name, path in local.lambda_artifacts :
    name => local.lambda_built[name] ? path : data.archive_file.lambda_placeholder.output_path
  }

  lambda_zip_hash = {
    for name, path in local.lambda_artifacts :
    name => local.lambda_built[name] ? filebase64sha256(path) : data.archive_file.lambda_placeholder.output_base64sha256
  }
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each = local.lambda_artifacts

  name              = "/aws/lambda/mvdis-${each.key}"
  retention_in_days = var.log_retention_days
}

# --- dispatcher ---

resource "aws_lambda_function" "dispatcher" {
  function_name    = "mvdis-dispatcher"
  role             = data.aws_iam_role.lab.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = local.lambda_zip["dispatcher"]
  source_code_hash = local.lambda_zip_hash["dispatcher"]
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      SCAN_QUEUE_URL = aws_sqs_queue.scan.url
      HOT_PER_TICK   = tostring(var.hot_per_tick)
      COLD_PER_TICK  = tostring(var.cold_per_tick)
    }
  }

  lifecycle {
    # dispatcher 只送 live 任務；超過 14 時 dispatcher 本身也會拒絕執行，這裡在 plan 階段就先擋下
    precondition {
      condition     = var.hot_per_tick + var.cold_per_tick <= 14
      error_message = "契約 §3：hot_per_tick + cold_per_tick 不得超過 14（LIVE_MAX_TASKS_PER_MINUTE）。"
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_cloudwatch_event_rule" "dispatch" {
  name                = "mvdis-dispatch-every-minute"
  description         = "每分鐘觸發 mvdis-dispatcher"
  schedule_expression = "rate(1 minute)"
  # dispatcher.zip 還沒打包時不啟用，避免佔位程式每分鐘報錯
  state = var.dispatcher_schedule_enabled && local.lambda_built["dispatcher"] ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "dispatch" {
  rule = aws_cloudwatch_event_rule.dispatch.name
  arn  = aws_lambda_function.dispatcher.arn
}

resource "aws_lambda_permission" "dispatch_from_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatcher.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.dispatch.arn
}

# --- notifier ---

resource "aws_lambda_function" "notifier" {
  function_name    = "mvdis-notifier"
  role             = data.aws_iam_role.lab.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = local.lambda_zip["notifier"]
  source_code_hash = local.lambda_zip_hash["notifier"]
  timeout          = 15
  memory_size      = 128

  environment {
    variables = {
      DISCORD_SECRET_ARN = aws_secretsmanager_secret.discord.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_sns_topic_subscription" "notifier" {
  topic_arn = aws_sns_topic.events.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.notifier.arn

  # 契約第 6 節：只收 target=live，實驗（replay）不洗版 Discord
  filter_policy_scope = "MessageAttributes"
  filter_policy       = jsonencode({ target = ["live"] })
}

resource "aws_lambda_permission" "notifier_from_sns" {
  statement_id  = "AllowSNSInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.events.arn
}

# --- janitor（契約 §2、§7：每日刪舊的 slot_event、過期 slot、舊 scan_task_log） ---

resource "aws_lambda_function" "janitor" {
  function_name    = "mvdis-janitor"
  role             = data.aws_iam_role.lab.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = local.lambda_zip["janitor"]
  source_code_hash = local.lambda_zip_hash["janitor"]
  timeout          = 300
  memory_size      = 256

  # 放 private 應用層：經同 AZ 的 NAT 連 Secrets Manager，經 Worker-SG 進 RDS
  vpc_config {
    subnet_ids         = [for s in aws_subnet.app : s.id]
    security_group_ids = [aws_security_group.worker.id]
  }

  environment {
    variables = {
      DB_HOST       = aws_db_instance.main.address
      DB_PORT       = tostring(aws_db_instance.main.port)
      DB_NAME       = var.db_name
      DB_SECRET_ARN = aws_secretsmanager_secret.db.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda, aws_route.app_nat]
}

# 台灣時間 04:00 = UTC 20:00（台灣沒有日光節約時間）。
# 不用 EventBridge Scheduler 的時區功能，因為它需要一個可被 scheduler.amazonaws.com 扮演的 role，Learner Lab 無法建立。
resource "aws_cloudwatch_event_rule" "janitor" {
  name                = "mvdis-janitor-daily"
  description         = "每日台灣時間 04:00 觸發 mvdis-janitor"
  schedule_expression = "cron(0 20 * * ? *)"
  state               = var.janitor_schedule_enabled && local.lambda_built["janitor"] ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "janitor" {
  rule = aws_cloudwatch_event_rule.janitor.name
  arn  = aws_lambda_function.janitor.arn
}

resource "aws_lambda_permission" "janitor_from_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.janitor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.janitor.arn
}
