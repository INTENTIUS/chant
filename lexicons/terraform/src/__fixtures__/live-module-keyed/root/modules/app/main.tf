variable "index" {
  type = number
}

# Expanded itself too, so its instances carry a key and a scope:
# `module.app[1].aws_eip.pool[0]`. EC2 assigns the allocation id, so
# choudoufu binds these by marker.
resource "aws_eip" "pool" {
  count  = 2
  domain = "vpc"
}

# Not expanded itself: its instances carry a scope and no key. The name is
# the identity, so choudoufu derives it from the configuration.
resource "aws_cloudwatch_log_group" "logs" {
  name = "/module-keyed-estate/app-${var.index}"
}
