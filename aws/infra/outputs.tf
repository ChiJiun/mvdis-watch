output "cloudfront_url" {
  description = "使用者入口（儀表板與 API）"
  value       = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "清快取用：aws cloudfront create-invalidation --distribution-id <id> --paths '/*'"
  value       = aws_cloudfront_distribution.main.id
}

output "alb_dns_name" {
  description = "ALB DNS；只收 CloudFront 帶 X-Origin-Verify 的請求，直接打會 403 或連不上"
  value       = aws_lb.api.dns_name
}

output "bastion_public_ip" {
  description = "Bastion 的 public IP（Learner Lab 重開 session 後會變，請重跑 terraform apply 或 refresh）"
  value       = aws_instance.bastion.public_ip
}

output "scan_queue_url" {
  value = aws_sqs_queue.scan.url
}

output "scan_dlq_url" {
  value = aws_sqs_queue.scan_dlq.url
}

output "event_topic_arn" {
  value = aws_sns_topic.events.arn
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "rds_endpoint" {
  description = "RDS 主機名稱（DB_HOST）"
  value       = aws_db_instance.main.address
}

output "rds_port" {
  value = aws_db_instance.main.port
}

output "rds_identifier" {
  description = "E2 強制主備切換：aws rds reboot-db-instance --db-instance-identifier <id> --force-failover"
  value       = aws_db_instance.main.identifier
}

output "db_name" {
  value = var.db_name
}

output "db_secret_arn" {
  value = aws_secretsmanager_secret.db.arn
}

output "discord_secret_arn" {
  description = "需手動填值的 Discord webhook secret"
  value       = aws_secretsmanager_secret.discord.arn
}

output "artifact_bucket" {
  value = aws_s3_bucket.artifacts.id
}

output "datalake_bucket" {
  description = "RAW_BUCKET"
  value       = aws_s3_bucket.datalake.id
}

output "glue_database" {
  value = aws_glue_catalog_database.mvdis.name
}

output "athena_workgroup" {
  value = aws_athena_workgroup.mvdis.name
}

output "worker_asg_name" {
  value = aws_autoscaling_group.worker.name
}

output "api_asg_name" {
  value = aws_autoscaling_group.api.name
}

output "replay_base_url" {
  description = "Replay 站內網位址；實驗時設成 worker_mvdis_base_url"
  value       = var.replay_enabled ? "http://${var.replay_private_ip}:8080" : null
}

output "lambda_functions" {
  value = {
    dispatcher = aws_lambda_function.dispatcher.function_name
    notifier   = aws_lambda_function.notifier.function_name
  }
}

output "artifacts_status" {
  description = "各打包產物是否已存在（not built 代表用了佔位程式或 instance 正在等 release）"
  value = merge(
    { for name, built in local.lambda_built : name => built ? "deployed" : "not built (placeholder)" },
    { for name, hash in local.release_hash : name => hash == "not-built" ? "not built (instances wait for s3 release)" : "uploaded" },
  )
}

output "private_subnet_ids" {
  description = "private 應用層 subnet（E2 依 AZ 找 instance 用）"
  value       = { for k, s in aws_subnet.app : k => { id = s.id, az = s.availability_zone } }
}
