variable "cidr" {
  type = string
}

resource "terraform_data" "subnet" {
  input = "${var.cidr}/b-v1"
}
