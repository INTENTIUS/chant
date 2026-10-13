# Vendored for TF033 (chant #2288) from https://github.com/zoitech/terraform-aws-concourse
# Path: rds.tf
# Commit: fa3f3c3eecaa9144ea556e52cd3c43bff3bdd510
# Licence: MIT, https://github.com/zoitech/terraform-aws-concourse/blob/fa3f3c3eecaa9144ea556e52cd3c43bff3bdd510/LICENSE
# The whole file, unmodified.
#
# TF033: one error. aws_db_instance.postgres does not set storage_encrypted, and the provider default is false.
# Its snapshot_identifier = "" is not a source: the provider reads it with GetOk, so "" is the same as unset.
#
# Copyright (c) 2017 Zoi TechCon GmbH
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

resource "aws_db_subnet_group" "postgres" {
  name       = "${lower(var.prefix)}-private"
  subnet_ids = var.private_sn

  tags = var.rds_tags
}

resource "aws_db_parameter_group" "concourse" {
  name   = "${var.prefix}-concourse-${var.postgres_family}"
  family = var.postgres_family

  tags = var.rds_tags
}

resource "aws_db_instance" "postgres" {
  identifier                = "${lower(var.prefix)}-concourse-db"
  allocated_storage         = var.concourse_db_storage
  storage_type              = "gp2"
  engine                    = "postgres"
  engine_version            = var.postgres_version
  instance_class            = var.concourse_db_size
  username                  = var.postgres_username
  password                  = local.postgres_password
  db_subnet_group_name      = aws_db_subnet_group.postgres.id
  parameter_group_name      = aws_db_parameter_group.concourse.id
  multi_az                  = var.postgres_multiaz
  backup_retention_period   = 35
  maintenance_window        = "Sat:21:00-Sun:00:00"
  backup_window             = "00:00-02:00"
  vpc_security_group_ids    = [aws_security_group.RuleGroupWsIn.id]
  copy_tags_to_snapshot     = true
  snapshot_identifier       = ""
  skip_final_snapshot       = true
  final_snapshot_identifier = "LastSnap"
  apply_immediately         = true

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [engine_version]
  }

  tags = merge({ Name = "${lower(var.prefix)}-concourse-db"}, var.rds_tags)
}

# Monitoring of DB events
resource "aws_sns_topic" "postgres" {
  name = "${lower(var.prefix)}-rds-topic"

  tags = merge({ Name = "${lower(var.prefix)}-rds-topic"}, var.sns_tags)
}

resource "aws_db_event_subscription" "postgres" {
  name      = "${lower(var.prefix)}-rds-sub"
  sns_topic = aws_sns_topic.postgres.arn

  source_type = "db-instance"
  source_ids  = [aws_db_instance.postgres.identifier]

  # see here for further event categories
  event_categories = [
    "low storage",
  ]
}

