# Vendored for TF033 (chant #2288) from https://github.com/bridgecrewio/terragoat
# Path: terraform/aws/rds.tf
# Commit: 729f8da62c6a85ce4af5ad3d123de97776d954c4
# Licence: Apache-2.0, https://github.com/bridgecrewio/terragoat/blob/729f8da62c6a85ce4af5ad3d123de97776d954c4/LICENSE
# Excerpt: lines 1-15, unmodified.
#
# TF033: one info, Not determined. An aws_rds_cluster with no engine (Aurora; provider v5 defaulted it to "aurora")
# and no storage_encrypted. AWS encrypts Aurora clusters created on or after 2026-02-16 whatever the
# configuration says, and the configuration does not say when this one was created.

resource "aws_rds_cluster" "app1-rds-cluster" {
  cluster_identifier      = "app1-rds-cluster"
  allocated_storage       = 10
  backup_retention_period = 0
  tags = {
    git_commit           = "079fe74f6b96d887c245664fbd8cf676c92f20e5"
    git_file             = "terraform/aws/rds.tf"
    git_last_modified_at = "2021-12-08 23:26:32"
    git_last_modified_by = "tron47@gmail.com"
    git_modifiers        = "tron47"
    git_org              = "matansha"
    git_repo             = "terragoat"
    yor_trace            = "b6f2c2ec-0715-46a0-83d4-502e588826d1"
  }
}
