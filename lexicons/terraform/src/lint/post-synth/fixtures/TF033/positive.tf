# Vendored for TF033 (chant #2288) from https://github.com/bridgecrewio/terragoat
# Path: terraform/aws/db-app.tf
# Commit: 729f8da62c6a85ce4af5ad3d123de97776d954c4
# Licence: Apache-2.0, https://github.com/bridgecrewio/terragoat/blob/729f8da62c6a85ce4af5ad3d123de97776d954c4/LICENSE
# Excerpt: lines 1-42, unmodified.
#
# TF033: one error. TerraGoat is a deliberately vulnerable estate; aws_db_instance.default writes storage_encrypted = false.

resource "aws_db_instance" "default" {

  name                   = var.dbname
  engine                 = "mysql"
  option_group_name      = aws_db_option_group.default.name
  parameter_group_name   = aws_db_parameter_group.default.name
  db_subnet_group_name   = aws_db_subnet_group.default.name
  vpc_security_group_ids = ["${aws_security_group.default.id}"]

  identifier              = "rds-${local.resource_prefix.value}"
  engine_version          = "8.0" # Latest major version 
  instance_class          = "db.t3.micro"
  allocated_storage       = "20"
  username                = "admin"
  password                = var.password
  apply_immediately       = true
  multi_az                = false
  backup_retention_period = 0
  storage_encrypted       = false
  skip_final_snapshot     = true
  monitoring_interval     = 0
  publicly_accessible     = true

  tags = merge({
    Name        = "${local.resource_prefix.value}-rds"
    Environment = local.resource_prefix.value
    }, {
    git_commit           = "e6d83b21346fe85d4fe28b16c0b2f1e0662eb1d7"
    git_file             = "terraform/aws/db-app.tf"
    git_last_modified_at = "2023-04-27 12:47:51"
    git_last_modified_by = "nadler@paloaltonetworks.com"
    git_modifiers        = "nadler/nimrodkor"
    git_org              = "bridgecrewio"
    git_repo             = "terragoat"
    yor_trace            = "47c13290-c2ce-48a7-b666-1b0085effb92"
  })

  # Ignore password changes from tf plan diff
  lifecycle {
    ignore_changes = ["password"]
  }
}
