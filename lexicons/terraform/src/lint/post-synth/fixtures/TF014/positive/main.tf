terraform {
  required_version = ">= 1.5.0"

  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "aws" {
  region = "us-east-1"
}

module "cdn" {
  source = "./modules/cdn"
  bucket = "assets"
}
