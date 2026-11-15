# RDS PostgreSQL 16 Multi-AZ（private 資料層）＋ Secrets Manager。
#
# secret 的 recovery_window_in_days = 0：destroy 時立即刪除，下一次 apply 才能用同一個名稱重建。

resource "random_password" "db" {
  length  = 32
  special = false # 避免應用程式組 DATABASE_URL 時要處理 URL escape
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${var.project}/db-credentials"
  description             = "RDS master 帳密，JSON {\"username\",\"password\"}（契約第 3 節 DB_SECRET_ARN）"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = var.db_username
    password = random_password.db.result
  })
}

# Discord webhook 只建空殼；值由使用者在 console 或 CLI 手動填（見 README）。
resource "aws_secretsmanager_secret" "discord" {
  name                    = "${var.project}/discord-webhook"
  description             = "Discord webhook，JSON {\"webhookUrl\":\"https://discord.com/api/webhooks/...\"}，請手動填值"
  recovery_window_in_days = 0
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-db-subnets"
  subnet_ids = [for s in aws_subnet.data : s.id]
  tags       = { Name = "${var.project}-db-subnets" }
}

resource "aws_db_instance" "main" {
  identifier     = "${var.project}-pg"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result
  port     = 5432

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  backup_retention_period = var.db_backup_retention_days
  apply_immediately       = true

  # Learner Lab：要能隨時 destroy 再重建
  deletion_protection      = false
  skip_final_snapshot      = true
  delete_automated_backups = true

  tags = { Name = "${var.project}-pg" }
}
