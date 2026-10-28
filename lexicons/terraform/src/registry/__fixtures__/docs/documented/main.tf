variable "name" {
  type        = string
  description = "The bucket's name."
}

output "bucket" {
  value = var.name
}
