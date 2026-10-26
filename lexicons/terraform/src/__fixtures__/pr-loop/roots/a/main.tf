variable "cidr" {
  type = string
}

resource "terraform_data" "subnet" {
  input = "${var.cidr}/a-v1"
}

output "id" {
  value = terraform_data.subnet.output
}
