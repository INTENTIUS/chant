variable "db_password" {
  type        = string
  description = "Password for the application database user"
  sensitive   = true
}

locals {
  ci_token = var.ci_token
  region   = "us-east-1"
}
