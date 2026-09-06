variable "db_password" {
  type        = string
  description = "Password for the application database user"
  default     = "hunter2-prod-db"
}

locals {
  ci_token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
}
