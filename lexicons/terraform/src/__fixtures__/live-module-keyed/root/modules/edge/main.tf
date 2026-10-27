variable "zone" {
  type = string
}

resource "aws_cloudwatch_log_group" "front" {
  name = "/module-keyed-estate/edge-${var.zone}"
}
