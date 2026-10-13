# Vendored for TF036 (chant #2288) from https://github.com/bridgecrewio/terragoat
# Path: terraform/aws/ec2.tf
# Commit: 729f8da62c6a85ce4af5ad3d123de97776d954c4
# Licence: Apache-2.0, https://github.com/bridgecrewio/terragoat/blob/729f8da62c6a85ce4af5ad3d123de97776d954c4/LICENSE
# Excerpt: lines 34-51, unmodified.
#
# TF036: one info, Not determined. The volume does not set encrypted, so whether it is encrypted depends on the
# Region's EBS encryption by default. The commented-out line in the source records why TerraGoat left
# encrypted = false out: "Setting this causes the volume to be recreated on apply".

resource "aws_ebs_volume" "web_host_storage" {
  # unencrypted volume
  availability_zone = "${var.region}a"
  #encrypted         = false  # Setting this causes the volume to be recreated on apply 
  size = 1
  tags = merge({
    Name = "${local.resource_prefix.value}-ebs"
    }, {
    git_commit           = "d3439f0f2af62f6fa3521e14d6c27819ef8f12e1"
    git_file             = "terraform/aws/ec2.tf"
    git_last_modified_at = "2021-05-02 11:17:26"
    git_last_modified_by = "nimrodkor@users.noreply.github.com"
    git_modifiers        = "nimrodkor"
    git_org              = "bridgecrewio"
    git_repo             = "terragoat"
    yor_trace            = "c5509daf-10f0-46af-9e03-41989212521d"
  })
}
