module "b" {
  source = "../b"
}

resource "null_resource" "a" {
  triggers = {
    name = "a"
  }
}
