terraform {
  required_version = ">= 1.5.0"

  live {
    estate = "fixture-estate"
  }

  backend "azurerm" {
    storage_account_name = "fixturestate"
    container_name       = "tfstate"
    key                  = "fixture.terraform.tfstate"
  }
}

resource "null_resource" "first" {}
