# Every reference form the index collects, once each, so a test can assert the
# whole vocabulary against one parse (chant #2112).
#
#   var.<name>              region, subnets
#   local.<name>            bucket_name, tags
#   data.<type>.<name>      data.aws_ami.ubuntu
#   module.<name>           module.cdn
#   provider = <type>.<alias>   provider.aws.replica, through both the
#                               `provider` meta-argument and a module's
#                               `providers` map

variable "region" {
  type = string
}

variable "subnets" {
  type = list(string)
}

locals {
  bucket_name = "assets-${var.region}"
  tags        = { Team = "platform" }
}

data "aws_ami" "ubuntu" {
  most_recent = true
}

provider "aws" {
  alias  = "replica"
  region = "eu-west-1"
}

resource "aws_instance" "web" {
  count     = length(var.subnets)
  ami       = data.aws_ami.ubuntu.id
  subnet_id = var.subnets[count.index]
  tags      = local.tags
}

resource "aws_s3_bucket" "replica" {
  provider = aws.replica
  bucket   = "${local.bucket_name}-replica"
}

module "cdn" {
  source = "./modules/cdn"

  providers = {
    aws = aws.replica
  }
}

output "cdn_url" {
  value = module.cdn.url
}
