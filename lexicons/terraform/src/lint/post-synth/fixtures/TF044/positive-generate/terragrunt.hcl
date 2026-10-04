generate "backend" {
  path      = "backend.tf"
  if_exists = "overwrite"
  contents  = <<-EOT
    terraform {
      backend "local" {}
    }
  EOT
}
