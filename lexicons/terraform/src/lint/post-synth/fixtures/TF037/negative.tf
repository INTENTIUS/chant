# Vendored for TF037 (chant #2288) from https://github.com/aws-samples/sample-scribe-ai
# Path: iac/ecr.tf
# Commit: 384cb260f7e57797bc7275b72db5b2b262eee858
# Licence: MIT-0, https://github.com/aws-samples/sample-scribe-ai/blob/384cb260f7e57797bc7275b72db5b2b262eee858/LICENSE
# The whole file, unmodified.
#
# TF037: silent. Both repositories set image_tag_mutability = "IMMUTABLE".

resource "aws_ecr_repository" "main" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "lambda" {
  name                 = "${var.name}-events"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}
