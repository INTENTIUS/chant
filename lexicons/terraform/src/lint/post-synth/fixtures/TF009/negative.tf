variable "db_password" {
  type        = string
  description = "Password for the application database user"
  sensitive   = true
}

variable "db_password_arn" {
  type        = string
  description = "Secrets Manager ARN the password is read from"
}
