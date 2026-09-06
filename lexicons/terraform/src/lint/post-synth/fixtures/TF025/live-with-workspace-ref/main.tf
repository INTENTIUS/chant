terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }
}

resource "null_resource" "first" {
  triggers = {
    workspace = "${terraform.workspace}"
  }
}
