terraform {
  required_version = ">= 1.5.0"

  backend "gcs" {
    bucket = "tfstate"
    prefix = "fixture"
  }
}

resource "null_resource" "first" {}
