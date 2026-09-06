terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = "~> 4.0"
  }
}

resource "aws_instance" "web" {
  ami = "ami-123"
}
