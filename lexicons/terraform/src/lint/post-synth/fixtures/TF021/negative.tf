variable "enabled" {
  type = bool
}

variable "subnets" {
  type = list(string)
}

# A count used as a switch. `for_each` does not replace this idiom, so it is
# never reported.
resource "aws_instance" "bastion" {
  count         = var.enabled ? 1 : 0
  instance_type = "t3.micro"
  tags = {
    Name = "bastion"
  }
}

# Plural, but `count.index` only picks a subnet out of a list. Reindexing is
# harmless here: no instance's identity moves.
resource "aws_instance" "web" {
  count         = length(var.subnets)
  instance_type = "t3.micro"
  subnet_id     = var.subnets[count.index]
}

# Already addressed by a stable key.
resource "aws_s3_bucket" "assets" {
  for_each = toset(["primary", "replica"])
  bucket   = "assets-${each.key}"
}
