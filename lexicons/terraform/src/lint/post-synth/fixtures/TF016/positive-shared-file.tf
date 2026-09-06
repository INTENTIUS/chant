resource "aws_s3_bucket" "assets" {
  bucket = "${var.assets_bucket}"
}

resource "aws_s3_bucket" "logs" {
  bucket = var.logs_bucket
}

output "assets_bucket" {
  description = "Name of the assets bucket"
  value       = aws_s3_bucket.assets.bucket
}
