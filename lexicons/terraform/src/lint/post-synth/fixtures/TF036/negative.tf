# Vendored for TF036 (chant #2288) from https://github.com/ned1313/terraform-tuesdays
# Path: 2021-04-13-AWS-KMS/ebs/main.tf
# Commit: 7651f6028ba18f01ad0273a15169e4058025c944
# Licence: MIT, https://github.com/ned1313/terraform-tuesdays/blob/7651f6028ba18f01ad0273a15169e4058025c944/LICENSE
# The whole file, unmodified.
#
# TF036: silent. The volume sets encrypted = true with a customer managed kms_key_id.
#
# Copyright (c) 2020 Ned Bellavance
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 3.0"
    }
  }
}

# Configure the AWS Provider
provider "aws" {
  region = var.region
}

variable "region" {
  type = string
  default = "us-east-1"
}

data "aws_availability_zones" "azs" {
  state = "available"
}

resource "aws_kms_key" "ebs" {
  description = "EBS key"
}

resource "aws_ebs_volume" "encrypted" {
  availability_zone = data.aws_availability_zones.azs.names[0]
  size              = 40
  encrypted = true
  kms_key_id = aws_kms_key.ebs.arn
}
