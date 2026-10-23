# The plan depth's real-binary fixture (#4358). Built-in `terraform_data`
# only, so `init` needs no registry and no network, and a `local` backend, so
# no credentials. `plan-read.acceptance.test.ts` copies it to a temp dir,
# applies it at generation 1, then reads a plan at generation 2
# (`next.tfvars`), which replaces one block, updates two, and leaves one
# value unknown until apply.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}

variable "generation" {
  type    = string
  default = "1"
}

# A sensitive default, on purpose: the redaction tests need a known secret
# to look for. TF006 is right about it in a real root.
# chant-ignore-block: TF006
variable "token" {
  type      = string
  default   = "hunter2"
  sensitive = true
}

# Replaced: `triggers_replace` forces it, so the plan carries
# `replace_paths = [["triggers_replace"]]` and an `action_reason`.
resource "terraform_data" "replaced" {
  triggers_replace = var.generation
  input            = "stable"
}

# Updated in place, with a sensitive value nested in a map.
resource "terraform_data" "updated" {
  input = {
    name  = "app-${var.generation}"
    token = var.token
  }
}

# Updated, and its input is unknown until apply: it reads the replaced
# block's new id.
resource "terraform_data" "downstream" {
  input = terraform_data.replaced.id
}
