# Vendored for TF030 from https://github.com/bridgecrewio/checkov
# Path: tests/terraform/checks/resource/aws/example_SecurityGroupUnrestrictedIngress22/main.tf
# Commit: 4ef6eb50e33f60d8a204138f08883e12494ac230
# Licence: Apache-2.0, https://github.com/bridgecrewio/checkov/blob/4ef6eb50e33f60d8a204138f08883e12494ac230/LICENSE
# Checkov's own test corpus for CKV_AWS_24. Excerpt: lines 63-98, the aws_security_group.fail4 and aws_security_group.fail-ipv6 blocks, unmodified.
#
# TF030: two errors: fail4 writes ingress in attribute syntax with protocol "-1" (every port), fail-ipv6 opens 22 to ::/0.

resource "aws_security_group" "fail4" {
  description = "SG with inline rules"
  ingress = [
    {
      cidr_blocks      = ["0.0.0.0/0"]
      description      = "Wide Open"
      from_port        = 0
      ipv6_cidr_blocks = []
      prefix_list_ids  = []
      security_groups  = []
      protocol         = "-1"
      self             = false
      to_port          = 65535
    }
  ]
}

resource "aws_security_group" "fail-ipv6" {
  name   = "sg-bar"
  vpc_id = aws_vpc.main.id

  ingress {
    from_port = 22
    to_port   = 22
    protocol  = "tcp"
    ipv6_cidr_blocks = ["192.168.0.0/16", "::/0"]
    description = "foo"
  }

  egress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
