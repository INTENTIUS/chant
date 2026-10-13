# No live block and no sidecar: this root's estate comes from
# terraform.roots.<name>.estate, which is the whole point of #2479.
resource "aws_iam_role" "app" {
  name = "app"
}
