terraform {
  live {
    estate = "fixture-estate"
  }

  backend "s3" {
    bucket = "tfstate"
    key    = "fixture/terraform.tfstate"
  }
}
