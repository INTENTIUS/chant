# Vendored for TF037 (chant #2288) from https://github.com/outerbounds/terraform-aws-metaflow
# Path: ecr.tf
# Commit: b56935a87aa623bf9c9d91efe22c54338dcef5a3
# Licence: Apache-2.0, https://github.com/outerbounds/terraform-aws-metaflow/blob/b56935a87aa623bf9c9d91efe22c54338dcef5a3/LICENSE
# The whole file, unmodified.
#
# TF037: one error. The repository does not set image_tag_mutability, and the provider default is MUTABLE.

resource "aws_ecr_repository" "metaflow_batch_image" {
  count = var.enable_custom_batch_container_registry ? 1 : 0

  name = local.metaflow_batch_image_name

  tags = var.tags
}
