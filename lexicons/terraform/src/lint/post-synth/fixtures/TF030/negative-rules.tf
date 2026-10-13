# Vendored for TF030 from https://github.com/aws-samples/aws-cloudwan-workshop-code
# Path: terraform/modules/compute/main.tf
# Commit: 1a331e8782b6cccdc5d0bb4ed28c45594445cc2f
# Licence: MIT-0, https://github.com/aws-samples/aws-cloudwan-workshop-code/blob/1a331e8782b6cccdc5d0bb4ed28c45594445cc2f/LICENSE
# Excerpt: lines 1-37, unmodified.
#
# TF030: silent. A group with no ingress at all (closed, not unknown), ICMP from 0.0.0.0/0 (no ports), SSH from a referenced security group rather than a CIDR, and an all-traffic egress rule.

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# --- modules/compute/main.tf ---

# ---------- EC2 INSTANCES ----------
# Security Group
resource "aws_security_group" "instance_sg" {
  name        = "${var.vpc_name}-instance-security-group-${var.project_name}"
  description = "EC2 Instance Security Group"
  vpc_id      = var.vpc_information.vpc_attributes.id
}

resource "aws_vpc_security_group_ingress_rule" "allowing_ingress_icmp" {
  security_group_id = aws_security_group.instance_sg.id

  from_port   = -1
  to_port     = -1
  ip_protocol = "icmp"
  cidr_ipv4   = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "allowing_ingress_eic" {
  security_group_id = aws_security_group.instance_sg.id

  from_port                    = 22
  to_port                      = 22
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.eic_sg.id
}

resource "aws_vpc_security_group_egress_rule" "allowing_egress_any" {
  security_group_id = aws_security_group.instance_sg.id

  ip_protocol = "-1"
  cidr_ipv4   = "0.0.0.0/0"
}
