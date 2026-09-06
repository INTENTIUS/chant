# This directory used to be a root module and kept its backend when it became
# a child. State belongs to the root that calls it, so the block below is the
# TF015 finding. `required_version` beside it is fine and is not reported.
terraform {
  required_version = ">= 1.5.0"

  backend "local" {
    path = "cdn.tfstate"
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "assets"
}
