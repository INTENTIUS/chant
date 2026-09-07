# The `terraform-apply-op` acceptance test copies this root into a temp
# directory and runs a real `terraform init`, `plan` and `apply` against it,
# so the backend has to be one that works with no credentials and no network
# beyond the provider registry. That is `local`, which is why TF001 reports
# this root (#2218): the finding is correct, and the local state is the point
# of the fixture. `remote-backend/` next door is the same configuration with
# a backend TF001 says nothing about.
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
