variable "access_key" {
  description = "HMAC access key ID used to sign origin requests"
  type        = string
  default     = null
}

variable "secret_key" {
  type      = string
  default   = null
  sensitive = true
}

variable "cloudsql_tier" {
  type    = string
  default = "db-custom-1-3840"
}

variable "image_name" {
  type    = string
  default = "ibm-ubuntu-24-04-3-minimal-s390x-2"
}

locals {
  machine_type = "n2-standard-4"
}
