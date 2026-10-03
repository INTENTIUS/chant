# Vendored for TF037 (chant #2288) from https://github.com/turnerlabs/terraform-ecs-fargate
# Path: base/ecr.tf
# Commit: e51d5f3bafdaa7cb29527da979a006d0b7bb1dfb
# Licence: Apache-2.0, https://github.com/turnerlabs/terraform-ecs-fargate/blob/e51d5f3bafdaa7cb29527da979a006d0b7bb1dfb/LICENSE
# Excerpt: lines 1-18, unmodified.
#
# TF037: one info, Not determined. image_tag_mutability = var.image_tag_mutability. The variable's default is
# "IMMUTABLE", but a caller can override it, and TF037 does not evaluate variables.

/*
 * ecr.tf
 * Creates a Amazon Elastic Container Registry (ECR) for the application
 * https://aws.amazon.com/ecr/
 */

# The tag mutability setting for the repository (defaults to IMMUTABLE)
variable "image_tag_mutability" {
  type        = string
  default     = "IMMUTABLE"
  description = "The tag mutability setting for the repository (defaults to IMMUTABLE)"
}

# create an ECR repo at the app/image level
resource "aws_ecr_repository" "app" {
  name                 = var.app
  image_tag_mutability = var.image_tag_mutability
}
