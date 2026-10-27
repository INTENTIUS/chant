terraform {
  backend "s3" {
    bucket = "tfstate"
    key    = "fixture/terraform.tfstate"
    region = "us-east-1"
  }
}
