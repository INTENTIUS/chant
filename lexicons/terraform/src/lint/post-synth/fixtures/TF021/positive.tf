resource "aws_instance" "web" {
  count         = 3
  instance_type = "t3.micro"

  tags = {
    Name = "web-${count.index}"
  }
}
