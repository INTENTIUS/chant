# Expansions the declared graph counts from variables, and blocks under
# expanded module calls (chant #4486). `n` defaults to 1 and terraform.tfvars
# sets it to 3, so a read that took the default would count one instance.

variable "n" {
  type    = number
  default = 1
}

variable "names" {
  type    = set(string)
  default = ["a", "b"]
}

variable "zones" {
  type    = list(string)
  default = ["x", "y"]
}

variable "unknown" {
  type = number
}

resource "aws_eip" "pool" {
  count  = var.n
  domain = "vpc"
}

resource "aws_s3_bucket" "named" {
  for_each = var.names
  bucket   = each.key
}

resource "aws_sqs_queue" "zoned" {
  count = length(var.zones)
  name  = var.zones[count.index]
}

resource "aws_sns_topic" "uncounted" {
  count = var.unknown
}

module "app" {
  source = "./modules/app"
  count  = 2
  size   = var.n
}

module "edge" {
  source   = "./modules/edge"
  for_each = toset(["east", "west"])
}
