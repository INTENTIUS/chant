terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "21.29.0"
}
