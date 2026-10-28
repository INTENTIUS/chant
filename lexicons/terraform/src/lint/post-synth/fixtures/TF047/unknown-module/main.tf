terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }
}

module "label" {
  source  = "cloudposse/label/null"
  version = "0.25.0"
}
