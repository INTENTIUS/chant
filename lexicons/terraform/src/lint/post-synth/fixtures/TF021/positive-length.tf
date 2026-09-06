variable "subnets" {
  type = list(string)
}

resource "aws_s3_bucket" "logs" {
  count  = length(var.subnets)
  bucket = "logs-${count.index}"
}
