# Vendored for TF030 from https://github.com/bridgecrewio/checkov
# Path: tests/terraform/checks/resource/aws/example_SecurityGroupUnrestrictedIngress22/main.tf
# Commit: 4ef6eb50e33f60d8a204138f08883e12494ac230
# Licence: Apache-2.0, https://github.com/bridgecrewio/checkov/blob/4ef6eb50e33f60d8a204138f08883e12494ac230/LICENSE
# Checkov's own test corpus for CKV_AWS_24. Excerpt: lines 100-116, the aws_security_group_rule.fail and aws_vpc_security_group_ingress_rule.fail blocks, unmodified.
#
# TF030: two errors, one per standalone shape: a 0.0.0.0/0 among other CIDRs on 22, and cidr_ipv4 = "0.0.0.0/0" on 22.

resource "aws_security_group_rule" "fail" {
  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  cidr_blocks       = ["192.168.0.0/16", "0.0.0.0/0"]
  security_group_id = aws_security_group.bar-sg.id
}

resource "aws_vpc_security_group_ingress_rule" "fail" {
  security_group_id = aws_security_group.example.id

  cidr_ipv4   = "0.0.0.0/0"
  from_port   = 22
  ip_protocol = "tcp"
  to_port     = 22
}
