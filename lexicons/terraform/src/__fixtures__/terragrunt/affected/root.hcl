remote_state {
  backend = "local"
  generate = { path = "backend.tf", if_exists = "overwrite" }
  config = { path = "${get_parent_terragrunt_dir()}/.state/${path_relative_to_include()}/terraform.tfstate" }
}
