terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"

    record_store "s3" {
      bucket = "fixture-records"
    }
  }

  backend "s3" {
    bucket = "tfstate"
    key    = "fixture/terraform.tfstate"
  }
}

resource "null_resource" "first" {}
