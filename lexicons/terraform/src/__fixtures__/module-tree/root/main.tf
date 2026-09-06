terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket = "tfstate"
    key    = "app/terraform.tfstate"
    region = "us-east-1"
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

module "cdn" {
  source = "./modules/cdn"
  region = var.region
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.2"
}

resource "aws_s3_bucket" "root_bucket" {
  bucket = "root-bucket"
}
