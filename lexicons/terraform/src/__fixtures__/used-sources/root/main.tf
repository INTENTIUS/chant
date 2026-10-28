terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.0"
}

module "net" {
  source = "./modules/net"
}

module "gone" {
  source = "./modules/missing"
}

module "outside" {
  source = "../../outside"
}

resource "random_id" "x" {
  byte_length = 4
}

resource "terraform_data" "t" {}
