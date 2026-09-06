variable "assets_bucket" {
  type        = string
  description = "Name of the bucket the site is served from"
}

resource "aws_s3_bucket" "assets" {
  bucket = var.assets_bucket
  tags = {
    name = "${var.assets_bucket}-assets"
  }
}

output "assets_bucket_arn" {
  description = "ARN of the assets bucket"
  value       = aws_s3_bucket.assets.arn
}
