# 鏈式 Security Group：每一層只收上一層的 SG，不用 CIDR。
#
#   CloudFront(prefix list) ──80──▶ ALB-SG ──8080──▶ API-SG ─┐
#                                                            ├─5432──▶ RDS-SG
#                                     Worker-SG ─────────────┤
#                                    Bastion-SG ─────────────┘
#                                     Worker-SG ──8080──▶ Replay-SG
#                                    Bastion-SG ──8080──▶ Replay-SG
#   admin_cidr ──22──▶ Bastion-SG ──22──▶ API-SG / Worker-SG / Replay-SG
#
# Bastion 同時是實驗主機：E1 佇列端、E2、E3 的腳本在 Bastion 上跑，要能直接連 RDS（清 replay schema、
# 讀量測結果）與 Replay 站（/admin/*）。worker 不能當跳板，因為 E2／E3 會把它關掉。
# Bastion 本身仍然只收 admin_cidr 的 22。

data "aws_ec2_managed_prefix_list" "cloudfront_origin" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.project}-alb-sg"
  description = "ALB: HTTP 80 only from CloudFront origin-facing prefix list"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.project}-alb-sg" }
}

resource "aws_security_group" "api" {
  name        = "${var.project}-api-sg"
  description = "API instances: 8080 only from ALB-SG"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.project}-api-sg" }
}

resource "aws_security_group" "worker" {
  name        = "${var.project}-worker-sg"
  description = "Crawler workers: no service port"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.project}-worker-sg" }
}

resource "aws_security_group" "bastion" {
  name        = "${var.project}-bastion-sg"
  description = "Bastion: SSH only from admin_cidr"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.project}-bastion-sg" }
}

resource "aws_security_group" "rds" {
  name        = "${var.project}-rds-sg"
  description = "RDS: 5432 only from API-SG, Worker-SG and Bastion-SG"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.project}-rds-sg" }
}

resource "aws_security_group" "replay" {
  name        = "${var.project}-replay-sg"
  description = "Replay mock site: 8080 only from Worker-SG and Bastion-SG"
  vpc_id      = aws_vpc.main.id
  tags        = { Name = "${var.project}-replay-sg" }
}

# --- ALB ---

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_cloudfront" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from CloudFront"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward and health check to API"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.api.id
}

# --- API ---

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "HTTP 8080 from ALB"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.alb.id
}

# --- SSH 只收 Bastion ---

resource "aws_vpc_security_group_ingress_rule" "ssh_from_bastion" {
  for_each = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
    replay = aws_security_group.replay.id
  }

  security_group_id            = each.value
  description                  = "SSH from Bastion"
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
  referenced_security_group_id = aws_security_group.bastion.id
}

resource "aws_vpc_security_group_ingress_rule" "bastion_ssh_from_admin" {
  security_group_id = aws_security_group.bastion.id
  description       = "SSH from admin"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = var.admin_cidr
}

# --- RDS ---

resource "aws_vpc_security_group_ingress_rule" "rds_from_app" {
  for_each = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
  }

  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

# 實驗主機（Bastion）直接連 RDS：migration、清 replay schema、讀 scan_task_log 量測結果。
# 這放寬了「RDS 只收應用層」的原設計；Bastion 只收 admin_cidr 的 SSH，所以實際上等同管理者可經 SSH tunnel 連 DB。
resource "aws_vpc_security_group_ingress_rule" "rds_from_bastion" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from Bastion (migration and experiments)"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.bastion.id
}

# --- Replay ---

resource "aws_vpc_security_group_ingress_rule" "replay_from_worker" {
  security_group_id            = aws_security_group.replay.id
  description                  = "HTTP 8080 from workers"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.worker.id
}

# 實驗腳本從 Bastion 呼叫 Replay 站的 /healthz 與 /admin/*（stats、reset、events、延遲設定）
resource "aws_vpc_security_group_ingress_rule" "replay_from_bastion" {
  security_group_id            = aws_security_group.replay.id
  description                  = "HTTP 8080 from Bastion (experiment scripts)"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.bastion.id
}

# --- 對外：應用層與 Bastion 需要經 NAT 連外（Secrets Manager、SQS、SNS、dnf、監理服務網）。
#     RDS-SG 不開任何 egress（RDS 不主動連外）。

resource "aws_vpc_security_group_egress_rule" "all_out" {
  for_each = {
    api     = aws_security_group.api.id
    worker  = aws_security_group.worker.id
    bastion = aws_security_group.bastion.id
    replay  = aws_security_group.replay.id
  }

  security_group_id = each.value
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
