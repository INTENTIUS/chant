module "gone" {
  source = "./modules/gone"
}

resource "null_resource" "here" {
  triggers = {
    name = "here"
  }
}
