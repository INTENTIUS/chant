variable "region" {
  type = string
}

variable "unused_in_child" {
  type    = string
  default = "nothing here reads this"
}

resource "aws_s3_bucket" "assets" {
  bucket = "assets"
  region = var.region
}
