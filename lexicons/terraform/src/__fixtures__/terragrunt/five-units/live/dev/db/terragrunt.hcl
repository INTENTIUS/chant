include "root" { path = find_in_parent_folders("root.hcl") }
terraform { source = "../../../modules/thing" }
dependency "live_dev_vpc" {
  config_path = "../vpc"
  mock_outputs = { id = "mock" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
}
inputs = { name = "live-dev-db", upstream = [ dependency.live_dev_vpc.outputs.id,] }
