# Vendored for TF037 (chant #2288) from https://github.com/bridgecrewio/terragoat
# Path: terraform/aws/ecr.tf
# Commit: 729f8da62c6a85ce4af5ad3d123de97776d954c4
# Licence: Apache-2.0, https://github.com/bridgecrewio/terragoat/blob/729f8da62c6a85ce4af5ad3d123de97776d954c4/LICENSE
# Excerpt: lines 1-18, unmodified.
#
# TF037: one error. image_tag_mutability = "MUTABLE".

resource aws_ecr_repository "repository" {
  name                 = "${local.resource_prefix.value}-repository"
  image_tag_mutability = "MUTABLE"


  tags = merge({
    Name = "${local.resource_prefix.value}-repository"
    }, {
    git_commit           = "e6d83b21346fe85d4fe28b16c0b2f1e0662eb1d7"
    git_file             = "terraform/aws/ecr.tf"
    git_last_modified_at = "2023-04-27 12:47:51"
    git_last_modified_by = "nadler@paloaltonetworks.com"
    git_modifiers        = "nadler/nimrodkor"
    git_org              = "bridgecrewio"
    git_repo             = "terragoat"
    yor_trace            = "7a3ec657-fa54-4aa2-8467-5d08d6c90bc2"
  })
}
