variable "cidr" {
  type = string
}

locals {
  base_tags = { Team = "platform" }
}

resource "aws_vpc" "main" {
  cidr_block = var.cidr
  tags       = local.base_tags
}

output "vpc_id" {
  value = aws_vpc.main.id
}
