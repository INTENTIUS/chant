# Epic #2284 acceptance estate, violating root. Written for chant, not
# vendored: the fidelity probe's fixtures (docs/design/waw-hcl-fidelity-probe.md)
# were never committed, so this root carries one violation per rule, TF030 to
# TF037, each written the way a real estate writes it. `chant audit` over this
# directory reports every one of them (src/lint/post-synth/estate-2284.test.ts).

terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket = "acme-terraform-state"
    key    = "payments/terraform.tfstate"
    region = "eu-west-1"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
}

# TF030: SSH open to the world.
resource "aws_security_group" "bastion" {
  name   = "bastion"
  vpc_id = "vpc-0a1b2c3d4e5f60718"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# TF031: an admin policy.
resource "aws_iam_policy" "deployer" {
  name = "deployer"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "*"
        Resource = "*"
      },
    ]
  })
}

# TF032: a database password in a container's environment.
resource "aws_ecs_task_definition" "api" {
  family                   = "payments-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"

  container_definitions = jsonencode([{
    name  = "api"
    image = "public.ecr.aws/acme/payments-api:1.4.2"
    environment = [
      { name = "LOG_LEVEL", value = "info" },
      { name = "DB_PASSWORD", value = "Pm-Pr0d-Db-2026!" }
    ]
  }])
}

# TF033: storage encryption written off.
resource "aws_db_instance" "ledger" {
  identifier          = "ledger"
  engine              = "postgres"
  instance_class      = "db.t4g.medium"
  allocated_storage   = 50
  username            = "ledger"
  password            = var.db_password
  storage_encrypted   = false
  skip_final_snapshot = true
}

variable "db_password" {
  type      = string
  sensitive = true
}

# TF034: a topic that names no key.
resource "aws_sns_topic" "alerts" {
  name = "payments-alerts"
}

# TF035: SSE-SQS turned off.
resource "aws_sqs_queue" "settlements" {
  name                    = "settlements"
  sqs_managed_sse_enabled = false
}

# TF036: a volume that asks not to be encrypted.
resource "aws_ebs_volume" "scratch" {
  availability_zone = "eu-west-1a"
  size              = 100
  encrypted         = false
}

# TF037: a repository left at the provider default, MUTABLE.
resource "aws_ecr_repository" "api" {
  name = "payments-api"
}
