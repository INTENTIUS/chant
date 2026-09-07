# The root's `var.region` is referenced only by the module call, which is
# still a reference: the scope of a variable is the module that declares it.
# The child module's own `var.unused_in_child` is referenced by nothing in the
# child, and the root's use of the name `region` says nothing about it.
terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket = "tfstate"
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

module "cdn" {
  source = "./modules/cdn"
  region = var.region
}
