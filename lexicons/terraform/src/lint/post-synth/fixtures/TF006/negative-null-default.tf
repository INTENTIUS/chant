variable "null_token" {
  type      = string
  sensitive = true
  default   = null
}

variable "optional_key" {
  description = "Only read when the feature is enabled"
  type        = string
  default     = null
  sensitive   = true
}
