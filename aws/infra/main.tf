data "aws_caller_identity" "current" {}

# Learner Lab 不能建 IAM role，只能引用預建的 LabRole（Lambda 用）。
data "aws_iam_role" "lab" {
  name = var.lab_role_name
}

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  account_id = data.aws_caller_identity.current.account_id

  app_dist_dir    = coalesce(var.app_dist_dir, "${path.module}/../app/dist")
  api_dist_dir    = coalesce(var.api_dist_dir, "${path.module}/../api/dist")
  replay_dist_dir = coalesce(var.replay_dist_dir, "${path.module}/../replay/dist")

  # 契約第 2 節：EC2 服務的打包產物
  ec2_artifacts = {
    worker = "${local.app_dist_dir}/worker.mjs"
    api    = "${local.api_dist_dir}/api.mjs"
    replay = "${local.replay_dist_dir}/replay.mjs"
  }

  # 契約第 2 節：Lambda 的打包產物
  lambda_artifacts = {
    dispatcher = "${local.app_dist_dir}/dispatcher.zip"
    notifier   = "${local.app_dist_dir}/notifier.zip"
    janitor    = "${local.app_dist_dir}/janitor.zip"
  }

  # 只上傳已經打包好的檔案；還沒打包的服務，instance 會由 systemd 每 10 秒重試下載。
  ec2_artifacts_built = { for name, path in local.ec2_artifacts : name => path if fileexists(path) }

  # 把產物的 md5 放進 user data：產物一變，launch template 就出新版本並觸發 instance refresh。
  release_hash = { for name, path in local.ec2_artifacts : name => fileexists(path) ? filemd5(path) : "not-built" }

  # 契約 §3：MVDIS_LIVE_URL 固定為官網 origin，不開放用變數修改
  mvdis_live_url = "https://www.mvdis.gov.tw"
}
