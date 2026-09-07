# Terraform Cloud / HCP holds the state, so there is no terraform.tfstate on
# the machine that runs the plan. `cloud {}` counts as remote for TF001.
terraform {
  required_version = ">= 1.5.0"

  cloud {
    organization = "acme"

    workspaces {
      name = "app"
    }
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
