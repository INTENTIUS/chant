# app: a security group in the VPC, a network interface in subnet a, and the
# port the app listens on, which is the port network's proxy forwards. Each
# variable is one of network's outputs, of the same name; app.component.ts
# fills them with stackOutput("network", ...).
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

variable "vpc_id" {
  type = string
}

variable "subnet_a_id" {
  type = string
}

variable "http_proxy_port" {
  type = string
}

variable "subnet_b_id" {
  type = string
}

locals {
  tags = {
    "chant:estate" = "chant-compose"
    "chant:tier"   = "app"
  }
}

resource "aws_security_group" "web" {
  description = "chant-compose web"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_network_interface" "web" {
  subnet_id = var.subnet_a_id
  tags      = local.tags
}

resource "aws_network_interface" "worker" {
  subnet_id = var.subnet_b_id
  tags      = local.tags
}

resource "aws_ssm_parameter" "listener_port" {
  name           = "/chant-compose/listener-port"
  type           = "String"
  insecure_value = var.http_proxy_port
}

output "listener_port" {
  value = var.http_proxy_port
}

output "worker_subnet_id" {
  value = aws_network_interface.worker.subnet_id
}
