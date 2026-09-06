terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }

  backend "s3" {
    bucket = "tfstate"
    key    = "fixture/terraform.tfstate"
  }
}

resource "null_resource" "first" {}
