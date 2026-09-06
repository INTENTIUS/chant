data "aws_ami" "base" {
  most_recent = true
  owners      = ["amazon"]

  lifecycle {
    ignore_changes = all
  }
}
