terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"

    scope {
      region = "us-east-1"
    }

    policy {
      undeclared_untagged = "delete"
    }
  }
}

resource "null_resource" "first" {}
