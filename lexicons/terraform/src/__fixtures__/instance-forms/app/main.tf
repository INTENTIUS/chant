# The expansion forms #4489 counts (literal locals, length() of a local, and
# a bool variable choosing between two whole numbers), and the forms that
# stay one node, each with its rollup reason.

variable "on" {
  type    = bool
  default = true
}

variable "off" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = { a = "1" }
}

variable "unknown" {
  type = number
}

variable "flag" {
  type = bool
}

locals {
  replicas = 2
  zones    = ["x", "y", "z"]
  names    = ["p", "q"]
  ports    = { http = 80, https = 443 }
  from_var = var.on
  computed = var.unknown
}

resource "aws_eip" "local_count" {
  count  = local.replicas
  domain = "vpc"
}

resource "aws_sqs_queue" "local_length" {
  count = length(local.zones)
  name  = local.zones[count.index]
}

resource "aws_s3_bucket" "local_set" {
  for_each = toset(local.names)
  bucket   = each.key
}

resource "aws_lb_listener" "local_map" {
  for_each = local.ports
  port     = each.value
}

resource "aws_sns_topic" "enabled" {
  count = var.on ? 1 : 0
  name  = "enabled"
}

resource "aws_sns_topic" "disabled" {
  count = var.off ? 1 : 0
  name  = "disabled"
}

resource "aws_sns_topic" "local_flag" {
  count = local.from_var ? 2 : 0
  name  = "local-flag"
}

resource "aws_sns_topic" "flag_unknown" {
  count = var.flag ? 1 : 0
  name  = "flag-unknown"
}

resource "aws_sns_topic" "local_unknown" {
  count = local.computed
  name  = "local-unknown"
}

resource "aws_iam_user" "merged" {
  for_each = merge(var.tags, { b = "2" })
  name     = each.key
}

resource "aws_iam_group" "each" {
  for_each = each.value
  name     = each.key
}

resource "aws_iam_role" "for_expr" {
  for_each = { for k, v in var.tags : k => v }
  name     = each.key
}

resource "aws_iam_policy" "arith" {
  count = local.replicas + 1
  name  = "arith"
}

resource "aws_eip" "too_many" {
  count  = 300
  domain = "vpc"
}

module "svc" {
  source = "./modules/svc"
  count  = var.unknown
}
