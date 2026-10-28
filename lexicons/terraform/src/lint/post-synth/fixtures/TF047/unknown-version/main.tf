terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}
