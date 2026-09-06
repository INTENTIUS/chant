module "a" {
  source = "../a"
}

resource "null_resource" "b" {
  triggers = {
    name = "b"
  }
}
