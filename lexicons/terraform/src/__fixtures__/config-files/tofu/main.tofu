variable "region" {
  type    = string
  default = "us-east-1"
}

resource "aws_s3_bucket" "assets" {
  bucket = "assets-${var.region}"
  tags = {
    team = "web"
  }
}
