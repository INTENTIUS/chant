module "shared" {
  source = "../../shared"
}

resource "null_resource" "here" {
  triggers = {
    name = "here"
  }
}
