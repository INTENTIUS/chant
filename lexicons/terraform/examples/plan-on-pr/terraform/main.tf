# A local state file is what this example wants: it is a null_resource root
# that runs on a scratch checkout, and a remote backend would need a bucket
# nobody provisions for an example. The CI shape this example is about does
# not depend on where the state lives.
# chant-ignore-block: TF001
terraform {
  required_version = ">= 1.5.0"

  backend "local" {
    path = "terraform.tfstate"
  }

  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

provider "null" {}

resource "null_resource" "app" {
  triggers = {
    name = "app"
  }
}
