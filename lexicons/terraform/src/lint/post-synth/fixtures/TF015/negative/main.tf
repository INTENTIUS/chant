terraform {
  required_version = ">= 1.5.0"

  backend "s3" {
    bucket = "tfstate"
    key    = "app/terraform.tfstate"
    region = "us-east-1"
  }
}

module "cdn" {
  source = "./modules/cdn"
}
