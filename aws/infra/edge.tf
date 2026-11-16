# 使用者 → CloudFront → ALB（public）→ API ASG
#
# ALB-SG 只收 CloudFront 的 origin-facing prefix list；但任何人自己開一個 CloudFront 也在那個
# prefix list 裡，所以另外加一個只有我們的 distribution 知道的 header，ALB 沒看到就回 403。

resource "random_password" "origin_verify" {
  length  = 40
  special = false
}

resource "aws_lb" "api" {
  name               = "${var.project}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [for s in aws_subnet.public : s.id]

  drop_invalid_header_fields = true
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "api" {
  name                 = "${var.project}-api-tg"
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "instance"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  # 契約第 8 節：/healthz 回 200 即健康
  health_check {
    path                = "/healthz"
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "from_cloudfront" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  condition {
    http_header {
      http_header_name = "X-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# --- CloudFront ---

# AWS 受管快取政策：遵守 origin 的 Cache-Control（api 回 public, max-age=30），query string 納入快取鍵
data "aws_cloudfront_cache_policy" "origin_cache_control" {
  name = "UseOriginCacheControlHeaders-QueryStrings"
}

resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  comment         = "mvdis-watch API + dashboard"
  price_class     = var.cloudfront_price_class
  is_ipv6_enabled = true

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.api.dns_name

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # ALB 沒有憑證（Learner Lab 沒有自己的網域）
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  default_cache_behavior {
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.origin_cache_control.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
