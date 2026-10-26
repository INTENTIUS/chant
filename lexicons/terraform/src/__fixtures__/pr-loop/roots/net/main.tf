resource "terraform_data" "vpc" {
  input = "10.0.0.0/16"
}

output "cidr" {
  value = terraform_data.vpc.output
}
