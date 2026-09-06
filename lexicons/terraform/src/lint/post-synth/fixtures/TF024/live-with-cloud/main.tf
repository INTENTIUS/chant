terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }

  cloud {
    organization = "acme"
    workspaces {
      name = "fixture"
    }
  }
}

resource "null_resource" "first" {}
