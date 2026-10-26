variable "subnet" {
  type = string
}

locals {
  # A second resource only on a subnet whose id ends in -wide. The count
  # reads var.subnet through a local, which the placeholder preview does not
  # follow (chant#4463), so the preview plans no wide instance. See README.md.
  wide = endswith(var.subnet, "-wide") ? 1 : 0
}

resource "terraform_data" "app" {
  input = "app on ${var.subnet}"
}

resource "terraform_data" "wide" {
  count = local.wide
  input = "wide on ${var.subnet}"
}
