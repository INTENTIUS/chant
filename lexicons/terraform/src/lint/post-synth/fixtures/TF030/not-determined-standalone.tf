# Vendored for TF030 from https://github.com/aws-samples/terraform-sample-workshop
# Path: module_1/one_file_tf/simple_nginx_stack/main.tf
# Commit: 0a265e356a3cf4fd0f15ba821b7bedf712a32239
# Licence: MIT-0, https://github.com/aws-samples/terraform-sample-workshop/blob/0a265e356a3cf4fd0f15ba821b7bedf712a32239/LICENSE
# Excerpt: lines 127-150, unmodified.
#
# TF030: one info, Not determined: allow_ssh_internal opens 22 to cidr_blocks = [var.cidr_vpc]. egress_allow_all (protocol "all", 0.0.0.0/0) is egress and is not reported.

resource "aws_security_group" "vpc_security_group" {
  name   = "aws-${var.vpc_name}-vpc-sg"
  vpc_id = aws_vpc.vpc.id
}

resource "aws_security_group_rule" "allow_ssh_internal" {
  type        = "ingress"
  from_port   = 22
  to_port     = 22
  protocol    = "tcp"
  cidr_blocks = [var.cidr_vpc]

  security_group_id = aws_security_group.vpc_security_group.id
}

resource "aws_security_group_rule" "egress_allow_all" {
  type        = "egress"
  from_port   = 0
  to_port     = 65535
  protocol    = "all"
  cidr_blocks = ["0.0.0.0/0"]

  security_group_id = aws_security_group.vpc_security_group.id
}
