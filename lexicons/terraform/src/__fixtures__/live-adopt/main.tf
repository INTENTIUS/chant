terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {}

# A VPC the acceptance test creates out of band, with no ownership marker on
# it, before this root ever plans. choudoufu's content matcher offers a VPC on
# `cidr_block` (`matchTable` in choudoufu's internal/live/foreign/classify.go),
# so an unmarked live VPC at this exact cidr is what makes this root's plan
# report one adoptable match rather than proposing a second VPC beside it.
resource "aws_vpc" "adoptable" {
  cidr_block = "10.77.0.0/16"
}
