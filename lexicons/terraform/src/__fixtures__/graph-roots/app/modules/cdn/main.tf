variable "bucket" {
  type = string
}

resource "aws_cloudfront_distribution" "cdn" {
  origin_id = var.bucket
}
