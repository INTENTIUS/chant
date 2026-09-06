terraform {
  required_version = ">= 1.5.0"

  backend "local" {
    path = "bucket.tfstate"
  }
}

resource "aws_s3_bucket" "assets" {
  bucket = "assets"
}
