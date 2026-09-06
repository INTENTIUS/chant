resource "aws_s3_bucket" "assets" {
  bucket = "${var.project}-assets"
}

resource "aws_s3_bucket" "logs" {
  bucket = "logs-${var.project}"
}
