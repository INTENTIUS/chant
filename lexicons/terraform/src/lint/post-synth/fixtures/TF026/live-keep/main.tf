terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"

    policy {
      undeclared_tagged = "keep"
    }
  }
}

resource "null_resource" "first" {}
