# An `alias`-only provider block declares a slot the caller fills through
# `providers = { aws.replica = aws.replica }`. It configures nothing, so TF014
# leaves it alone.
provider "aws" {
  alias = "replica"
}

variable "bucket" {
  type = string
}

resource "aws_s3_bucket" "assets" {
  bucket = var.bucket
}

resource "aws_s3_bucket" "replica" {
  provider = aws.replica
  bucket   = "${var.bucket}-replica"
}
