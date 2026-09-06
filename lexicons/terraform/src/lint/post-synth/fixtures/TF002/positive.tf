terraform {
  required_version = ">= 1.5.0"
}

resource "google_compute_instance" "vm" {
  name = "vm"
}
