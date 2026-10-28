terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }
}

module "sqs" {
  source  = "terraform-aws-modules/sqs/aws"
  version = "5.2.2"
}
