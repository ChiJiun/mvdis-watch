# 雙 AZ VPC：每個 AZ 一個 public、private 應用層、private 資料層 subnet，各一個 NAT Gateway。
#
#   AZ-a                          AZ-b
#   public   10.0.0.0/24          public   10.0.1.0/24    ← ALB、NAT、Bastion
#   app      10.0.10.0/24         app      10.0.11.0/24   ← worker、API、Replay
#   data     10.0.20.0/24         data     10.0.21.0/24   ← RDS

locals {
  az_keys = { a = 0, b = 1 }
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-igw" }
}

resource "aws_subnet" "public" {
  for_each = local.az_keys

  vpc_id                  = aws_vpc.main.id
  availability_zone       = var.azs[each.value]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, each.value)
  map_public_ip_on_launch = true

  tags = { Name = "${var.project}-public-${each.key}", Tier = "public" }
}

resource "aws_subnet" "app" {
  for_each = local.az_keys

  vpc_id            = aws_vpc.main.id
  availability_zone = var.azs[each.value]
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 10 + each.value)

  tags = { Name = "${var.project}-app-${each.key}", Tier = "app" }
}

resource "aws_subnet" "data" {
  for_each = local.az_keys

  vpc_id            = aws_vpc.main.id
  availability_zone = var.azs[each.value]
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 20 + each.value)

  tags = { Name = "${var.project}-data-${each.key}", Tier = "data" }
}

# --- public 路由 ---

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-rt-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# --- 每個 AZ 一個 NAT Gateway，應用層只走同 AZ 的 NAT（一個 AZ 掛掉不影響另一個） ---

resource "aws_eip" "nat" {
  for_each = local.az_keys

  domain = "vpc"
  tags   = { Name = "${var.project}-nat-eip-${each.key}" }
}

resource "aws_nat_gateway" "main" {
  for_each = local.az_keys

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags = { Name = "${var.project}-nat-${each.key}" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "app" {
  for_each = local.az_keys

  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-rt-app-${each.key}" }
}

resource "aws_route" "app_nat" {
  for_each = local.az_keys

  route_table_id         = aws_route_table.app[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[each.key].id
}

resource "aws_route_table_association" "app" {
  for_each = aws_subnet.app

  subnet_id      = each.value.id
  route_table_id = aws_route_table.app[each.key].id
}

# --- 資料層：不對外，只有 VPC 內部路由 ---

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-rt-data" }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}

# S3 Gateway Endpoint（免費）：worker 寫資料湖、instance 下載 release 不必繞 NAT，省 NAT 流量費（E4）。
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [for rt in aws_route_table.app : rt.id]

  tags = { Name = "${var.project}-s3-endpoint" }
}
