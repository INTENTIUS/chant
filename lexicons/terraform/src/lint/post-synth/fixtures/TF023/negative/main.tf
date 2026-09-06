terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket = "acme-tfstate"
    key    = "app/terraform.tfstate"
    region = "eu-west-1"
  }
}

resource "null_resource" "first" {
  triggers = {
    name = "first"
  }
}
