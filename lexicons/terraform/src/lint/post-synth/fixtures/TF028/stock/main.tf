terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket = "tfstate"
    key    = "fixture"
  }
}

resource "null_resource" "first" {}
