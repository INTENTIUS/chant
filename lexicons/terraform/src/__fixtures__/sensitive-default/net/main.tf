# Sensitive variables with literal defaults, for the redaction tests (chant
# #4377). TF006 is suppressed on purpose: the defaults are the point.

# Local state on purpose: nothing applies this fixture.
# chant-ignore-block: TF001
terraform {
  required_version = ">= 1.6"
}

# chant-ignore-block: TF006, TF007
variable "api_token" {
  type      = string
  default   = "tok-string-9f3a"
  sensitive = true
}

# chant-ignore-block: TF006, TF007
variable "db_port" {
  default   = 5432917
  sensitive = true
}

# chant-ignore-block: TF006, TF007
variable "creds" {
  sensitive = true
  default = {
    user = "admin-map-77"
    pass = "pw-map-c0ffee"
  }
}

variable "region" {
  default = "us-east-1"
}

resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}
