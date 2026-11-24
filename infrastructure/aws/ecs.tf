resource "aws_security_group" "load_balancer" {
  name_prefix = "${var.name}-alb-"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "tasks" {
  name_prefix = "${var.name}-ecs-"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.load_balancer.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "load_balancer_to_api" {
  security_group_id            = aws_security_group.load_balancer.id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
}

resource "aws_vpc_security_group_ingress_rule" "api_from_load_balancer" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.load_balancer.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "tasks_to_database" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = var.database_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_ingress_rule" "database_from_tasks" {
  security_group_id            = var.database_security_group_id
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_lb" "api" {
  name                       = "${var.name}-api"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.load_balancer.id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = 4000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    enabled = true
    path    = "/health/ready"
    matcher = "200"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.api_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_route53_record" "api" {
  zone_id = var.route53_zone_id
  name    = var.api_hostname
  type    = "A"

  alias {
    name                   = aws_lb.api.dns_name
    zone_id                = aws_lb.api.zone_id
    evaluate_target_health = true
  }
}

resource "aws_ecs_cluster" "main" {
  name = var.name
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(["api", "worker", "migrate"])
  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = 14
}

locals {
  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "S3_REGION", value = var.region },
    { name = "S3_BUCKET", value = aws_s3_bucket.media.id },
    { name = "SQS_QUEUE_URL", value = aws_sqs_queue.processing.url },
  ]
  app_secrets = [{ name = "DATABASE_URL", valueFrom = var.database_url_secret_arn }]
  service_logs = {
    for name, group in aws_cloudwatch_log_group.service : name => {
      logDriver = "awslogs"
      options = {
        awslogs-group         = group.name
        awslogs-region        = var.region
        awslogs-stream-prefix = name
      }
    }
  }
  processes = {
    api = {
      image   = var.api_image
      cpu     = 512
      memory  = 1024
      desired = var.api_desired_count
      env = concat(local.common_env, [
        { name = "PORT", value = "4000" },
        { name = "HOST", value = "0.0.0.0" },
        { name = "WEB_ORIGIN", value = var.frontend_origin },
        { name = "API_PUBLIC_URL", value = "https://${var.api_hostname}" },
        { name = "CLOUDFRONT_URL", value = "https://${aws_cloudfront_distribution.media.domain_name}" },
        { name = "CLOUDFRONT_KEY_PAIR_ID", value = aws_cloudfront_public_key.media.id },
      ])
      secrets = concat(local.app_secrets, [
        { name = "MEDIA_TOKEN_SECRET", valueFrom = var.media_token_secret_arn },
        { name = "CLOUDFRONT_PRIVATE_KEY", valueFrom = var.cloudfront_private_key_secret_arn },
      ])
      health = "node -e \"fetch('http://127.0.0.1:4000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""
    }
    worker = {
      image   = var.worker_image
      cpu     = 2048
      memory  = 4096
      desired = var.worker_desired_count
      env = concat(local.common_env, [
        { name = "WORKER_CONCURRENCY", value = "1" },
        { name = "WORKER_FFMPEG_THREADS", value = "2" },
      ])
      secrets = local.app_secrets
      health  = local.worker_health
    }
  }
}

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.processes
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(each.value.cpu)
  memory                   = tostring(each.value.memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.application[each.key].arn
  container_definitions = jsonencode([{
    name             = each.key
    image            = each.value.image
    essential        = true
    stopTimeout      = 45
    environment      = each.value.env
    secrets          = each.value.secrets
    portMappings     = each.key == "api" ? [{ containerPort = 4000, protocol = "tcp" }] : []
    logConfiguration = local.service_logs[each.key]
    healthCheck      = { command = ["CMD-SHELL", each.value.health], interval = 30, timeout = 5, retries = 3, startPeriod = 40 }
    linuxParameters  = { initProcessEnabled = true }
  }])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name             = "migrate"
    image            = var.migration_image
    essential        = true
    secrets          = [{ name = "DATABASE_URL", valueFrom = var.migration_database_url_secret_arn }]
    logConfiguration = local.service_logs.migrate
  }])
}

resource "aws_ecs_service" "service" {
  for_each                           = local.processes
  name                               = "${var.name}-${each.key}"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.service[each.key].arn
  desired_count                      = each.value.desired
  launch_type                        = "FARGATE"
  health_check_grace_period_seconds  = each.key == "api" ? 90 : null
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.key == "api" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api.arn
      container_name   = "api"
      container_port   = 4000
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.execution, aws_iam_role_policy.secrets,
    aws_iam_role_policy.api, aws_iam_role_policy.worker, aws_s3_bucket_policy.media,
    aws_lb_listener.https, aws_vpc_security_group_ingress_rule.database_from_tasks,
  ]
}
