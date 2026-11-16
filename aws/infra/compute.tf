# EC2：worker ASG、API ASG、Bastion、Replay 站。
# 全部用 Amazon Linux 2023 + LabInstanceProfile，IMDSv2 強制。

locals {
  db_env = {
    AWS_REGION    = var.region
    DB_HOST       = aws_db_instance.main.address
    DB_PORT       = tostring(aws_db_instance.main.port)
    DB_NAME       = var.db_name
    DB_SECRET_ARN = aws_secretsmanager_secret.db.arn
  }

  # 契約 §3：REPLAY_BASE_URL 只在開了 Replay 站時設定
  replay_base_url = var.replay_enabled ? "http://${var.replay_private_ip}:8080" : null

  service_env = {
    worker = merge(
      local.db_env,
      {
        SCAN_QUEUE_URL     = aws_sqs_queue.scan.url
        EVENT_TOPIC_ARN    = aws_sns_topic.events.arn
        RAW_BUCKET         = aws_s3_bucket.datalake.id
        MVDIS_LIVE_URL     = local.mvdis_live_url
        WORKER_CONCURRENCY = tostring(var.worker_concurrency)
      },
      local.replay_base_url == null ? {} : { REPLAY_BASE_URL = local.replay_base_url },
    )
    api = merge(local.db_env, {
      PORT = "8080"
    })
    replay = {
      AWS_REGION = var.region
      PORT       = "8080"
    }
  }

  # Windows 上 git 的 autocrlf 可能把範本轉成 CRLF，bash 會因 "\r" 失敗，所以一律轉回 LF
  #（.gitattributes 也強制 LF，這裡是第二道保險）
  user_data = {
    for name, env in local.service_env : name => replace(templatefile("${path.module}/templates/user_data.sh.tftpl", {
      name            = name
      region          = var.region
      artifact_bucket = aws_s3_bucket.artifacts.id
      env             = env
      release_hash    = local.release_hash[name]
      log_group       = aws_cloudwatch_log_group.ec2[name].name
    }), "\r\n", "\n")
  }
}

resource "aws_cloudwatch_log_group" "ec2" {
  for_each = local.ec2_artifacts

  name              = "/mvdis/${each.key}"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------------------
# Launch templates
# ---------------------------------------------------------------------------

resource "aws_launch_template" "service" {
  for_each = {
    worker = { instance_type = var.worker_instance_type, sg = aws_security_group.worker.id }
    api    = { instance_type = var.api_instance_type, sg = aws_security_group.api.id }
  }

  name_prefix            = "${var.project}-${each.key}-"
  image_id               = data.aws_ami.al2023.id
  instance_type          = each.value.instance_type
  key_name               = var.key_name
  vpc_security_group_ids = [each.value.sg]
  user_data              = base64encode(local.user_data[each.key])

  iam_instance_profile {
    name = var.lab_instance_profile_name
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  monitoring {
    enabled = false
  }

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.project}-${each.key}", Role = each.key }
  }

  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${var.project}-${each.key}" }
  }

  # release 上傳完才有意義；同時確保 user data 引用的資源都已存在
  depends_on = [aws_s3_object.release]
}

# ---------------------------------------------------------------------------
# worker ASG：跨兩個 AZ 的 private 應用層，依 SQS 積壓量擴縮
# ---------------------------------------------------------------------------

resource "aws_autoscaling_group" "worker" {
  name                = "${var.project}-worker-asg"
  vpc_zone_identifier = [for s in aws_subnet.app : s.id]
  min_size            = var.worker_min_size
  max_size            = var.worker_max_size
  desired_capacity    = var.worker_min_size

  health_check_type         = "EC2"
  health_check_grace_period = 120
  default_instance_warmup   = 120
  wait_for_capacity_timeout = "0"

  # target tracking 的分母（GroupInServiceInstances）需要開群組指標
  enabled_metrics     = ["GroupInServiceInstances", "GroupDesiredCapacity", "GroupTotalInstances"]
  metrics_granularity = "1Minute"

  launch_template {
    id      = aws_launch_template.service["worker"].id
    version = aws_launch_template.service["worker"].latest_version
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.project}-worker"
    propagate_at_launch = true
  }

  lifecycle {
    # desired 交給 scaling policy 與 E3 實驗腳本調整，terraform apply 不要蓋回去
    ignore_changes = [desired_capacity]
  }
}

# 契約第 9 節：ApproximateNumberOfMessagesVisible / InService 台數 做 target tracking
resource "aws_autoscaling_policy" "worker_backlog" {
  name                   = "${var.project}-worker-backlog-per-instance"
  autoscaling_group_name = aws_autoscaling_group.worker.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    target_value = var.worker_backlog_per_instance_target

    customized_metric_specification {
      metrics {
        id          = "visible"
        label       = "mvdis-scan visible messages"
        return_data = false

        metric_stat {
          stat = "Sum"
          metric {
            namespace   = "AWS/SQS"
            metric_name = "ApproximateNumberOfMessagesVisible"
            dimensions {
              name  = "QueueName"
              value = aws_sqs_queue.scan.name
            }
          }
        }
      }

      metrics {
        id          = "inservice"
        label       = "worker InService instances"
        return_data = false

        metric_stat {
          stat = "Average"
          metric {
            namespace   = "AWS/AutoScaling"
            metric_name = "GroupInServiceInstances"
            dimensions {
              name  = "AutoScalingGroupName"
              value = aws_autoscaling_group.worker.name
            }
          }
        }
      }

      metrics {
        id          = "backlog_per_instance"
        label       = "visible messages per InService worker"
        expression  = "visible / inservice"
        return_data = true
      }
    }
  }
}

# ---------------------------------------------------------------------------
# API ASG：跨兩個 AZ，掛在 ALB target group 後面
# ---------------------------------------------------------------------------

resource "aws_autoscaling_group" "api" {
  name                = "${var.project}-api-asg"
  vpc_zone_identifier = [for s in aws_subnet.app : s.id]
  min_size            = var.api_min_size
  max_size            = var.api_max_size
  desired_capacity    = var.api_min_size
  target_group_arns   = [aws_lb_target_group.api.arn]

  # api.mjs 還沒打包時改用 EC2 健康檢查，避免 ALB 判定不健康後一直砍掉重開
  health_check_type         = local.release_hash["api"] == "not-built" ? "EC2" : "ELB"
  health_check_grace_period = 180
  default_instance_warmup   = 120
  wait_for_capacity_timeout = "0"

  enabled_metrics     = ["GroupInServiceInstances", "GroupDesiredCapacity", "GroupTotalInstances"]
  metrics_granularity = "1Minute"

  launch_template {
    id      = aws_launch_template.service["api"].id
    version = aws_launch_template.service["api"].latest_version
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }

  tag {
    key                 = "Name"
    value               = "${var.project}-api"
    propagate_at_launch = true
  }

  lifecycle {
    ignore_changes = [desired_capacity]
  }
}

resource "aws_autoscaling_policy" "api_cpu" {
  name                   = "${var.project}-api-cpu"
  autoscaling_group_name = aws_autoscaling_group.api.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    target_value = var.api_cpu_target

    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
  }
}

# ---------------------------------------------------------------------------
# Bastion（public subnet AZ-a）
# ---------------------------------------------------------------------------

resource "aws_instance" "bastion" {
  ami                         = data.aws_ami.al2023.id
  instance_type               = var.bastion_instance_type
  key_name                    = var.key_name
  subnet_id                   = aws_subnet.public["a"].id
  vpc_security_group_ids      = [aws_security_group.bastion.id]
  associate_public_ip_address = true
  iam_instance_profile        = var.lab_instance_profile_name

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tags = { Name = "${var.project}-bastion", Role = "bastion" }

  lifecycle {
    # AMI 更新時不要因此重建 bastion
    ignore_changes = [ami]
  }
}

# ---------------------------------------------------------------------------
# Replay 模擬站（可選，E3 用）：AZ-a private 應用層，固定 private IP
# ---------------------------------------------------------------------------

resource "aws_instance" "replay" {
  count = var.replay_enabled ? 1 : 0

  ami                         = data.aws_ami.al2023.id
  instance_type               = var.replay_instance_type
  key_name                    = var.key_name
  subnet_id                   = aws_subnet.app["a"].id
  private_ip                  = var.replay_private_ip
  vpc_security_group_ids      = [aws_security_group.replay.id]
  iam_instance_profile        = var.lab_instance_profile_name
  user_data                   = local.user_data["replay"]
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  tags = { Name = "${var.project}-replay", Role = "replay" }

  lifecycle {
    ignore_changes = [ami]

    precondition {
      condition     = can(regex("^10\\.0\\.10\\.([4-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$", var.replay_private_ip))
      error_message = "replay_private_ip 必須落在 AZ-a 應用層 10.0.10.0/24，且避開 AWS 保留的 .0–.3 與 .255。"
    }
  }

  depends_on = [aws_s3_object.release]
}
