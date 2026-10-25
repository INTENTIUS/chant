# edge: the ranges it lets through, and the upstream it routes to, which is
# app on the port app listens on. edge.component.ts fills listener_port with
# stackOutput("app", "listener_port").
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

variable "listener_port" {
  type = string
}

resource "aws_ssm_parameter" "allowlist" {
  name           = "/chant-compose/allowlist"
  type           = "String"
  insecure_value = "10.0.1.0/24"
}

resource "aws_ssm_parameter" "upstream" {
  name           = "/chant-compose/upstream"
  type           = "String"
  insecure_value = "http://app:${var.listener_port}"
}
