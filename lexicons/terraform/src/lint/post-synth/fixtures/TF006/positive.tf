variable "deploy_token" {
  type        = string
  description = "Token the deploy job authenticates with"
  sensitive   = true
  default     = "carried-over-from-the-old-staging-account"
}
