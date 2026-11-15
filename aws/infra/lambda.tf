# dispatcher（EventBridge 每分鐘觸發 → 送 SQS）與 notifier（SNS → Discord）。
# 兩者都不放 VPC：dispatcher 無狀態不連 DB（契約第 4 節），notifier 只連 Secrets Manager 與 Discord。
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
      SCAN_TARGET    = var.scan_target
      HOT_PER_TICK   = tostring(var.hot_per_tick)
      COLD_PER_TICK  = tostring(var.cold_per_tick)
    }
  }

  lifecycle {
    precondition {
      condition     = var.scan_target != "live" || var.hot_per_tick + var.cold_per_tick <= 14
      error_message = "契約第 3、4 節：live 模式下 hot_per_tick + cold_per_tick 不得超過 14（LIVE_MAX_TASKS_PER_MINUTE）。"
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
