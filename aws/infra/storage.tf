# S3：artifact bucket（各服務的 release）與資料湖 bucket（raw/、events/、athena-results/）。
# bucket 名稱帶 account id 確保全域唯一；force_destroy 讓 terraform destroy 能整個拆掉。

resource "aws_s3_bucket" "artifacts" {
  bucket        = "${var.project}-artifacts-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket" "datalake" {
  bucket        = "${var.project}-datalake-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each = {
    artifacts = aws_s3_bucket.artifacts.id
    datalake  = aws_s3_bucket.datalake.id
  }

  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = {
    artifacts = aws_s3_bucket.artifacts.id
    datalake  = aws_s3_bucket.datalake.id
  }

  bucket = each.value

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "datalake" {
  bucket = aws_s3_bucket.datalake.id

  rule {
    id     = "expire-athena-results"
    status = "Enabled"

    filter {
      prefix = "athena-results/"
    }

    expiration {
      days = 7
    }
  }
}

# 上傳已打包的 EC2 服務：s3://<artifact_bucket>/releases/<name>.mjs（契約第 2 節）
resource "aws_s3_object" "release" {
  for_each = local.ec2_artifacts_built

  bucket       = aws_s3_bucket.artifacts.id
  key          = "releases/${each.key}.mjs"
  source       = each.value
  etag         = filemd5(each.value)
  content_type = "text/javascript"
}

# ---------------------------------------------------------------------------
# Glue Data Catalog + Athena：查 s3://<datalake>/events/dt=YYYY-MM-DD/*.jsonl（dt 為台灣時間的日期，契約 §5）
# 用 partition projection，不必跑 crawler 或 MSCK REPAIR 就能依 dt 分區查詢。
# ---------------------------------------------------------------------------

resource "aws_glue_catalog_database" "mvdis" {
  name = "${var.project}_datalake"
}

resource "aws_glue_catalog_table" "events" {
  name          = "events"
  database_name = aws_glue_catalog_database.mvdis.name
  table_type    = "EXTERNAL_TABLE"

  parameters = {
    EXTERNAL               = "TRUE"
    classification         = "json"
    "projection.enabled"   = "true"
    "projection.dt.type"   = "date"
    "projection.dt.format" = "yyyy-MM-dd"
    # dt 是台灣時間（UTC+8）的日期，而 NOW 以 UTC 計算：台灣 00:00–08:00 時當天分區會比 NOW 多一天，所以上限放寬到 NOW+1DAYS
    "projection.dt.range"         = "2026-01-01,NOW+1DAYS"
    "projection.dt.interval"      = "1"
    "projection.dt.interval.unit" = "DAYS"
    "storage.location.template"   = "s3://${aws_s3_bucket.datalake.id}/events/dt=$${dt}/"
  }

  partition_keys {
    name = "dt"
    type = "string"
  }

  storage_descriptor {
    location      = "s3://${aws_s3_bucket.datalake.id}/events/"
    input_format  = "org.apache.hadoop.mapred.TextInputFormat"
    output_format = "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat"

    ser_de_info {
      serialization_library = "org.openx.data.jsonserde.JsonSerDe"
      parameters = {
        "case.insensitive"      = "TRUE"
        "ignore.malformed.json" = "TRUE"
      }
    }

    # 欄位對應 aws/shared/contracts.ts 的 SlotEvent（Glue 欄位名一律小寫，JSON SerDe 不分大小寫比對）
    columns {
      name = "licensetype"
      type = "string"
    }
    columns {
      name = "dmvno"
      type = "string"
    }
    columns {
      name = "examdate"
      type = "string"
    }
    columns {
      name = "seckey"
      type = "string"
    }
    columns {
      name = "kind"
      type = "string"
    }
    columns {
      name = "oldquota"
      type = "int"
    }
    columns {
      name = "newquota"
      type = "int"
    }
    columns {
      name    = "at"
      type    = "bigint"
      comment = "epoch ms"
    }
    columns {
      name = "taskid"
      type = "string"
    }
    columns {
      name = "runid"
      type = "string"
    }
  }
}

resource "aws_athena_workgroup" "mvdis" {
  name          = var.project
  force_destroy = true

  configuration {
    enforce_workgroup_configuration = true

    result_configuration {
      output_location = "s3://${aws_s3_bucket.datalake.id}/athena-results/"
    }
  }
}
