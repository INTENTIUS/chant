terraform {
  backend "gcs" {
    bucket = "tfstate"
    prefix = "fixture"
  }
}
