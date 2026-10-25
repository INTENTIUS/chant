# The estate's network: a VPC, one subnet in it, and the port the proxy
# listens on, kept as an SSM parameter. app reads the VPC and subnet ids and
# the port; nothing here reads another root.
#
# The state stays on local disk: the demo runs against an emulator, and an s3
# backend would need a bucket before the first apply. TF001 is suppressed
# here rather than satisfied.
# chant-ignore-block: TF001
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

locals {
  tags = {
    "chant:estate" = "chant-compose"
    "chant:tier"   = "network"
  }

  # A value of the source, so the parameter and the output read the same constant.
  http_proxy_port = "8090"
  admin_port      = "9000"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags       = local.tags
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
  tags       = local.tags
}

resource "aws_ssm_parameter" "http_proxy_port" {
  name           = "/chant-compose/http-proxy-port"
  type           = "String"
  insecure_value = local.http_proxy_port
}

resource "aws_ssm_parameter" "admin_port" {
  name           = "/chant-compose/admin-port"
  type           = "String"
  insecure_value = local.admin_port
}

output "vpc_id" {
  value = aws_vpc.main.id
}

output "subnet_a_id" {
  value = aws_subnet.a.id
}

output "http_proxy_port" {
  value = local.http_proxy_port
}

output "admin_port" {
  value = local.admin_port
}
