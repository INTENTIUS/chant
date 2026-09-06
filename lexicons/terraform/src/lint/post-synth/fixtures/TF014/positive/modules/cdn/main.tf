# The provider block TF014 reports: this module configures its own region, so
# its caller cannot point it anywhere else, and Terraform cannot remove the
# module without deleting the provider its own destroy needs.
provider "aws" {
  region  = "us-east-1"
  profile = "cdn"
}

variable "bucket" {
  type = string
}

resource "aws_s3_bucket" "assets" {
  bucket = var.bucket
}
