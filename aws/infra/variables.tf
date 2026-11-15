# ---------------------------------------------------------------------------
# 一般
# ---------------------------------------------------------------------------

variable "region" {
  description = "AWS 區域。Learner Lab 只能用 us-east-1（或 us-west-2）。"
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "資源名稱前綴與 Project tag。佇列、topic 名稱依契約固定為 mvdis-*，不受這個值影響。"
  type        = string
  default     = "mvdis"
}

variable "azs" {
  description = "使用的兩個 AZ。E2 實驗會關掉第一個 AZ（AZ-a）的所有 instance。"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]

  validation {
    condition     = length(var.azs) == 2
    error_message = "架構固定為雙 AZ，azs 必須剛好兩個。"
  }
}

variable "admin_cidr" {
  description = "允許 SSH 到 Bastion 的來源 CIDR，例如 \"203.0.113.10/32\"。必填。"
  type        = string

  validation {
    condition     = can(cidrhost(var.admin_cidr, 0)) && var.admin_cidr != "0.0.0.0/0"
    error_message = "admin_cidr 必須是合法 CIDR，而且不能是 0.0.0.0/0。"
  }
}

variable "key_name" {
  description = "EC2 key pair 名稱。Learner Lab 預設提供 vockey（在 AWS Details 下載 labsuser.pem）。"
  type        = string
  default     = "vockey"
}

variable "lab_role_name" {
  description = "Learner Lab 預建、給 Lambda 用的 IAM role 名稱。"
  type        = string
  default     = "LabRole"
}

variable "lab_instance_profile_name" {
  description = "Learner Lab 預建、給 EC2 用的 instance profile 名稱。"
  type        = string
  default     = "LabInstanceProfile"
}

variable "log_retention_days" {
  description = "CloudWatch Logs 保留天數。"
  type        = number
  default     = 14
}

# ---------------------------------------------------------------------------
# 打包產物（契約第 2 節）。預設路徑相對於 aws/infra/。
# ---------------------------------------------------------------------------

variable "app_dist_dir" {
  description = "worker 線的打包輸出目錄（dispatcher.zip、notifier.zip、worker.mjs）。null 代表 ../app/dist。"
  type        = string
  default     = null
}

variable "api_dist_dir" {
  description = "api 線的打包輸出目錄（api.mjs）。null 代表 ../api/dist。"
  type        = string
  default     = null
}

variable "replay_dist_dir" {
  description = "replay 線的打包輸出目錄（replay.mjs）。null 代表 ../replay/dist。"
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------
# dispatcher
# ---------------------------------------------------------------------------

variable "dispatcher_schedule_enabled" {
  description = "EventBridge 每分鐘排程是否啟用。dispatcher.zip 還沒打包時一律停用。"
  type        = bool
  default     = true
}

variable "scan_target" {
  description = "dispatcher 的 SCAN_TARGET：live 或 replay。"
  type        = string
  default     = "live"

  validation {
    condition     = contains(["live", "replay"], var.scan_target)
    error_message = "scan_target 只能是 live 或 replay。"
  }
}

variable "hot_per_tick" {
  description = "dispatcher 每分鐘送出的熱門組合數（HOT_PER_TICK）。"
  type        = number
  default     = 11
}

variable "cold_per_tick" {
  description = "dispatcher 每分鐘送出的冷門組合數（COLD_PER_TICK）。live 模式下 hot + cold 不得超過 14。"
  type        = number
  default     = 3
}

# ---------------------------------------------------------------------------
# worker ASG
# ---------------------------------------------------------------------------

variable "worker_instance_type" {
  type    = string
  default = "t3.micro"
}

variable "worker_min_size" {
  type    = number
  default = 1
}

variable "worker_max_size" {
  description = "E3 會跑到 8 台。"
  type        = number
  default     = 8
}

variable "worker_concurrency" {
  description = "WORKER_CONCURRENCY：單台同時處理幾則訊息。"
  type        = number
  default     = 5
}

variable "worker_backlog_per_instance_target" {
  description = "target tracking 目標值：每台 InService worker 平均分到的可見訊息數。"
  type        = number
  default     = 50
}

variable "worker_mvdis_base_url" {
  description = "worker 的 MVDIS_BASE_URL。實驗時改成 output replay_base_url（例如 http://10.0.10.200:8080）。"
  type        = string
  default     = "https://www.mvdis.gov.tw"
}

# ---------------------------------------------------------------------------
# API ASG
# ---------------------------------------------------------------------------

variable "api_instance_type" {
  type    = string
  default = "t3.micro"
}

variable "api_min_size" {
  description = "最少 2 台才能每個 AZ 各一台（E2 高可用）。"
  type        = number
  default     = 2
}

variable "api_max_size" {
  type    = number
  default = 6
}

variable "api_cpu_target" {
  description = "API ASG 的 CPU target tracking 目標（%）。"
  type        = number
  default     = 50
}

# ---------------------------------------------------------------------------
# Bastion / Replay
# ---------------------------------------------------------------------------

variable "bastion_instance_type" {
  type    = string
  default = "t3.micro"
}

variable "replay_enabled" {
  description = "是否建立 Replay 模擬站（E3 用）。"
  type        = bool
  default     = false
}

variable "replay_instance_type" {
  type    = string
  default = "t3.small"
}

variable "replay_private_ip" {
  description = "Replay 站固定的 private IP，必須落在 AZ-a 的 private 應用層（10.0.10.0/24）。"
  type        = string
  default     = "10.0.10.200"
}

# ---------------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------------

variable "db_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "db_multi_az" {
  description = "RDS Multi-AZ。E2 需要開啟；只想省錢測試時可關掉。"
  type        = bool
  default     = true
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "mvdis"
}

variable "db_username" {
  type    = string
  default = "mvdis"
}

variable "db_backup_retention_days" {
  description = "自動備份保留天數；0 代表關閉（建立與刪除會比較快）。"
  type        = number
  default     = 1
}

# ---------------------------------------------------------------------------
# CloudWatch alarm
# ---------------------------------------------------------------------------

variable "alarm_email" {
  description = "收 alarm 通知的 email；null 代表不訂閱（alarm 仍會建立，只是沒人收）。"
  type        = string
  default     = null
}

variable "rds_cpu_alarm_threshold" {
  type    = number
  default = 80
}

variable "worker_error_alarm_threshold" {
  description = "5 分鐘內 live 任務的 ScanErrors 總數超過這個值就告警。"
  type        = number
  default     = 10
}

# ---------------------------------------------------------------------------
# CloudFront
# ---------------------------------------------------------------------------

variable "cloudfront_price_class" {
  description = "PriceClass_200 包含亞洲節點（使用者在台灣）。"
  type        = string
  default     = "PriceClass_200"
}
