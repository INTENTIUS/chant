# The root `show-state.json` next door was recorded from: this configuration
# was applied with terraform 1.15.8 against a local backend, and the resulting
# `terraform show -json` saved verbatim. `null_resource.third` is declared here
# and deliberately absent from that state, which is what an OBSERVED-ABSENT
# entity looks like.

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

resource "null_resource" "third" {
  triggers = {
    name = "third"
  }
}

module "cdn" {
  source = "./modules/inner"
}

variable "region" {
  type    = string
  default = "us-east-1"
}
