variable "region" {
  type    = string
  default = "us-east-1"
}

variable "retention_days" {
  type = number

  validation {
    condition     = var.retention_days > 0
    error_message = "retention_days must be positive."
  }
}

locals {
  common_tags = { Team = "platform" }
  bucket_name = "assets"
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

provider "aws" {
  alias  = "replica"
  region = "eu-west-1"
}

resource "aws_s3_bucket" "assets" {
  bucket = local.bucket_name
  region = var.region
  tags   = local.common_tags
}

resource "aws_s3_bucket" "replica" {
  provider = aws.replica
  bucket   = "${local.bucket_name}-replica"
}

resource "aws_instance" "web" {
  ami                    = data.aws_ami.ubuntu.id
  log_retention_in_days  = var.retention_days
}
