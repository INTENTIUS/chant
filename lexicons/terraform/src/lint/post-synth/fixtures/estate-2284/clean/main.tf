# Epic #2284 acceptance estate, clean root. Written for chant, not vendored.
# The same estate as ../violating with every finding fixed, and with the
# provider-default cases left as real estates leave them: an SQS queue that
# sets no encryption attribute (encrypted by AWS's SSE-SQS default), an EBS
# volume that leaves `encrypted` unset but depends on an enabled
# `aws_ebs_encryption_by_default`, an SNS topic on the AWS managed key, and an
# ECR repository that keeps `latest` mutable through an exclusion filter.
# TF030 to TF037 report nothing here (src/lint/post-synth/estate-2284.test.ts).

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

# TF030: HTTPS from anywhere, SSH from the VPC only.
resource "aws_security_group" "web" {
  name   = "web"
  vpc_id = "vpc-0a1b2c3d4e5f60718"

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/8"]
  }
}

# TF031: named actions on named resources.
data "aws_iam_policy_document" "deployer" {
  statement {
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_task_definition.api.arn]
  }
}

resource "aws_iam_policy" "deployer" {
  name   = "deployer"
  policy = data.aws_iam_policy_document.deployer.json
}

# TF032: the password comes from Secrets Manager.
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
      { name = "LOG_LEVEL", value = "info" }
    ]
    secrets = [
      { name = "DB_PASSWORD", valueFrom = "arn:aws:secretsmanager:eu-west-1:111122223333:secret:ledger-db" }
    ]
  }])
}

# TF033: encrypted storage.
resource "aws_db_instance" "ledger" {
  identifier          = "ledger"
  engine              = "postgres"
  instance_class      = "db.t4g.medium"
  allocated_storage   = 50
  username            = "ledger"
  password            = var.db_password
  storage_encrypted   = true
  skip_final_snapshot = true
}

variable "db_password" {
  type      = string
  sensitive = true
}

# TF034: the AWS managed key.
resource "aws_sns_topic" "alerts" {
  name              = "payments-alerts"
  kms_master_key_id = "alias/aws/sns"
}

# TF035: provider default. No encryption attribute; SQS encrypts new queues
# with SSE-SQS.
resource "aws_sqs_queue" "settlements" {
  name = "settlements"
}

# TF036: provider default. `encrypted` unset, the Region's encryption by
# default turned on first.
resource "aws_ebs_encryption_by_default" "on" {}

resource "aws_ebs_volume" "scratch" {
  availability_zone = "eu-west-1a"
  size              = 100
  depends_on        = [aws_ebs_encryption_by_default.on]
}

# TF037: immutable tags, with `latest` as the one written-down exception.
resource "aws_ecr_repository" "api" {
  name                 = "payments-api"
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"

  image_tag_mutability_exclusion_filter {
    filter      = "latest"
    filter_type = "WILDCARD"
  }
}
