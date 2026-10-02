# Vendored for TF030 from https://github.com/aws-samples/sample-issac-lab-on-aws
# Path: main.tf
# Commit: 50ea76d87d873c1d69bed92c450ab144894f437e
# Licence: MIT-0, https://github.com/aws-samples/sample-issac-lab-on-aws/blob/50ea76d87d873c1d69bed92c450ab144894f437e/LICENSE
# Excerpt: lines 116-146, the aws_security_group.isaac block, unmodified.
#
# TF030: one info, Not determined: port 22 is open to cidr_blocks = var.allowed_ssh_cidrs, which the parse cannot read. No error.

resource "aws_security_group" "isaac" {
  name_prefix = "${var.project_name}-sg-"
  description = "Isaac Lab training instance security group"
  vpc_id      = aws_vpc.isaac.id

  # SSH
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.allowed_ssh_cidrs
  }

  # All outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-sg"
    Project = var.project_name
  }

  lifecycle {
    create_before_destroy = true
  }
}
