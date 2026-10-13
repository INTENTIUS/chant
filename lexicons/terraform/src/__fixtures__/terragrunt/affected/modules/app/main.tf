variable "name" { type = string }
module "net" {
  source = "../net"
  name   = var.name
}
resource "terraform_data" "this" { input = { name = var.name, policy = file("${path.module}/policy.json") } }
