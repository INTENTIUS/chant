# Vendored for TF030 from https://github.com/gruntwork-io/terratest
# Path: examples/terraform-ssh-example/main.tf
# Commit: 75a9f881c31f71255b474149edada4a1850bce22
# Licence: Apache-2.0, https://github.com/gruntwork-io/terratest/blob/75a9f881c31f71255b474149edada4a1850bce22/LICENSE
# Excerpt: lines 61-80, the aws_security_group.example block, unmodified.
#
# TF030: one info, Not determined: the CIDR is 0.0.0.0/0 but from_port and to_port are var.ssh_port. The open egress is not reported.

resource "aws_security_group" "example" {
  name = var.instance_name

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port = var.ssh_port
    to_port   = var.ssh_port
    protocol  = "tcp"

    # To keep this example simple, we allow incoming SSH requests from any IP. In real-world usage, you should only
    # allow SSH requests from trusted servers, such as a bastion host or VPN server.
    cidr_blocks = ["0.0.0.0/0"]
  }
}
