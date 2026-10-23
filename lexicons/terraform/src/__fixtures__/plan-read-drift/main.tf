# The plan depth's recorded document (#4358): `../show-plan.json` is
# `terraform show -json` over a saved plan of this root. README.md next door
# is the recording log. `plan-read/` holds the same `terraform_data` blocks
# without the shell provider, for the tests that run a real binary offline.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }

  required_providers {
    shell = {
      source  = "scottwinkler/shell"
      version = "~> 1.7"
    }
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

# Drifts: the recording rewrites conf.json between apply and plan, so the
# refresh finds the object changed outside Terraform (`resource_drift`).
resource "shell_script" "conf" {
  working_directory = path.module

  lifecycle_commands {
    create = "printf '{\"port\":\"8080\"}' > conf.json; cat conf.json"
    read   = "cat conf.json"
    delete = "rm -f conf.json"
  }
}

# Reads the drifted object, so the plan lists it in `relevant_attributes`.
resource "terraform_data" "reader" {
  input = shell_script.conf.output["port"]
}

resource "terraform_data" "replaced" {
  triggers_replace = var.generation
  input            = "stable"
}

resource "terraform_data" "updated" {
  input = {
    name  = "app-${var.generation}"
    token = var.token
  }
}

resource "terraform_data" "downstream" {
  input = terraform_data.replaced.id
}
