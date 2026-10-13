# Vendored for TF032 (chant #2287). Source: https://github.com/edstem-tech/paylink-platform
# Path: terraform/ecs.tf
# Commit: 2bbcbcce09434286cf90d20f69df0bd3ffa4cd00
# Licence: MIT
# Copyright (c) 2025 EdStem. MIT licence: permission notice at https://github.com/edstem-tech/paylink-platform/blob/2bbcbcce09434286cf90d20f69df0bd3ffa4cd00/LICENSE
# Copied verbatim below this header. Fires twice: DB_PASSWORD and PAYMENT_API_KEY are literals in environment.

resource "aws_ecs_cluster" "main" {
  name = "paylink-prod"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "paylink-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = "2048"
  task_role_arn            = aws_iam_role.task.arn
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([{
    name  = "api"
    image = "${var.ecr_repo}:latest"

    portMappings = [{ containerPort = 8080 }]

    environment = [
      { name = "SPRING_PROFILES_ACTIVE", value = "prod" },
      { name = "DB_PASSWORD", value = "Pl-Pr0d-Db-2025!" },
      { name = "PAYMENT_API_KEY", value = "pk_live_4RtYuIoP2aSdF6gH8jK" }
    ]

    healthCheck = {
      command  = ["CMD-SHELL", "curl -f http://localhost:8080/actuator/health || exit 1"]
      interval = 10
      timeout  = 2
      retries  = 3
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "paylink-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = true
  }
}
