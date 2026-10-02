# Vendored for TF030 from https://github.com/aws-samples/terraform-ec2-image-builder-container-hardening-pipeline
# Path: sec-groups.tf
# Commit: 68c34a21e966afc11c572677c319f2cc8379ec94
# Licence: MIT-0, https://github.com/aws-samples/terraform-ec2-image-builder-container-hardening-pipeline/blob/68c34a21e966afc11c572677c319f2cc8379ec94/LICENSE
# The whole file, unmodified.
#
# TF030: one error, on the "Ephemeral" ingress: tcp 1025-65535 from 0.0.0.0/0 spans 3306, 3389 and 5432. The TLS ingress on 443 is not reported.

resource "aws_security_group" "image_builder_sg" {
  depends_on = [
    aws_vpc.hardening_pipeline
  ]
  name        = "${var.image_name}-sg"
  description = "Security group for EC2 Image Builder"
  vpc_id      = aws_vpc.hardening_pipeline.id

  ingress {
    description = "TLS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Ephemeral"
    from_port   = 1025
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description      = "Allow all eggress"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = local.core_tags
}