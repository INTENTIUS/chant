# The state stays on local disk on purpose: this example is run by hand from a
# checkout, and pointing it at an s3 or gcs backend would make a first
# `terraform apply` need credentials and a bucket nobody has. TF001 is
# suppressed here rather than satisfied, and a real estate should satisfy it.
# chant-ignore-block: TF001
terraform {
  required_version = ">= 1.5.0"

  backend "local" {
    path = "terraform.tfstate"
  }

  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

provider "null" {}

resource "null_resource" "first" {
  triggers = {
    name = "first"
  }
}

resource "null_resource" "second" {
  triggers = {
    name = "second"
  }
}
