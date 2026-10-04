variable "name" { type = string }
resource "terraform_data" "net" { input = "${var.name}-net" }
