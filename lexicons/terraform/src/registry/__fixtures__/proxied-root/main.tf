terraform {
  required_providers {
    aws = {
      source = "acme.jfrog.io/tf-remote__hashicorp/aws"
    }
  }
}

module "vpc" {
  source  = "acme.jfrog.io/tf-remote__terraform-aws-modules/vpc/aws"
  version = "5.1.0"
}
