variable "region" {
  type = string
}

provider "aws" {
  region = var.region
}

module "bucket" {
  source = "./modules/bucket"
}

resource "aws_cloudfront_distribution" "cdn" {
  comment = "cdn in ${var.region}"
}
