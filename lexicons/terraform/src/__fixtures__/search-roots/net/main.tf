# One VPC, two subnets, three security groups, and the rules and instances
# that reference them, for `chant search` over a terraform.roots project
# (chant #4365, #4368). Lint-clean, so `chant graph --format ir` draws it and
# the tests can compare the two commands' node ids.

# Local state on purpose: nothing applies this fixture.
# chant-ignore-block: TF001
terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.1.0/24"
}

resource "aws_subnet" "b" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.0.2.0/24"
}

resource "aws_security_group" "web" {
  vpc_id = aws_vpc.main.id

  ingress {
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["10.0.0.0/16"]
  }
}

resource "aws_security_group" "batch" {
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "db" {
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group_rule" "db_pg" {
  type                     = "ingress"
  security_group_id        = aws_security_group.db.id
  source_security_group_id = aws_security_group.web.id
  protocol                 = "tcp"
  from_port                = 5432
  to_port                  = 5432
}

resource "aws_instance" "web" {
  ami                    = "ami-12345678"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.a.id
  vpc_security_group_ids = [aws_security_group.web.id]
}

resource "aws_instance" "db" {
  ami                    = "ami-12345678"
  instance_type          = "t3.micro"
  subnet_id              = aws_subnet.b.id
  vpc_security_group_ids = [aws_security_group.db.id]
}
