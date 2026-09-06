provider "aws" {
  region = "eu-west-1"
}

provider "google" {
  project     = "acme-prod"
  credentials = "keys/terraform-deployer.json"
}
