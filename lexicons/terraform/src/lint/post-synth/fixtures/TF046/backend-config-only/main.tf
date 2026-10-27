terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }

  # bucket and region come from -backend-config, which choudoufu does not read.
  backend "s3" {
    key = "fixture/terraform.tfstate"
  }
}

resource "null_resource" "first" {}
