variable "name" { type = string }
variable "upstream" { 
  type = list(string)
  default = [] 
}
resource "terraform_data" "this" { input = { name = var.name, upstream = var.upstream } }
output "id" { value = "${var.name}-id" }
