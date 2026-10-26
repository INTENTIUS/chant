variable "size" {
  type = number
}

resource "aws_instance" "web" {
  count         = var.size
  instance_type = "t3.micro"
}

resource "aws_iam_role" "runner" {
  name = "runner"
}
