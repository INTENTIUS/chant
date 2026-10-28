variable "cidr" {
  type        = string
  description = "The VPC's IPv4 CIDR block."
}

variable "tags" {
  type        = map(string)
  default     = {}
  description = "Tags for every resource."
}

variable "flow_log_key" {
  type      = string
  default   = "not-a-real-key"
  sensitive = true
}
