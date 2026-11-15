terraform {
  required_providers {
    fastly = {
      source  = "fastly/fastly"
      version = "~> 8.6.0"
    }
  }
}

resource "fastly_service_vcl" "s" {
  name = "s"
}
