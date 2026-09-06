resource "null_resource" "shared" {
  triggers = {
    name = "shared"
  }
}
