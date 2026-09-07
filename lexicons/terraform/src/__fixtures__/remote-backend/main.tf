# The `with-backend` root next door keeps its state local on purpose, so
# TF001 reports it (#2218). This one is the same configuration with a remote
# backend, and is what a root TF001 says nothing about looks like. Nothing
# ever runs `terraform init` here, so the bucket need not exist.
terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket = "tfstate"
    key    = "app/terraform.tfstate"
    region = "us-east-1"
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
