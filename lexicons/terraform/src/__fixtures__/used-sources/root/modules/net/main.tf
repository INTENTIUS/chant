module "sg" {
  source = "git::https://git.acme.dev/sg.git?ref=v1.0.0"
}

module "back" {
  source = "../.."
}

resource "aws_vpc" "v" {
  provider   = aws.west
  cidr_block = "10.0.0.0/16"
}

resource "thing_widget" "w" {}
