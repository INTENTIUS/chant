variable "project_id" {
  type = string
}

variable "name" {
  type = string
}

variable "description" {
  type    = string
  default = ""
}

variable "cluster_namespace" {
  type = string
}

variable "project_roles" {
  type    = list(string)
  default = []
}
