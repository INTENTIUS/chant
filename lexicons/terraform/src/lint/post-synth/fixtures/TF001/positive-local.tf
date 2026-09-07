# `backend "local"` is the local backend asked for by name: the same
# terraform.tfstate in the working directory a root with no backend block
# falls back to. TF001 reports it for that reason (#2218).
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
