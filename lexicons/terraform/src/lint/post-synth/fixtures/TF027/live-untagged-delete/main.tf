terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"

    policy {
      undeclared_untagged = "delete"
    }
  }
}

resource "null_resource" "first" {}
