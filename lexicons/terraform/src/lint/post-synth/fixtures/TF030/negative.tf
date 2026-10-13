# Vendored for TF030 from https://github.com/aws-samples/web-hosting-architecture-examples-for-china-region-terraform
# Path: eks/security-groups.tf
# Commit: 718a45d536672e7f5f4e1fa6011e3acb27ab4f5a
# Licence: MIT-0, https://github.com/aws-samples/web-hosting-architecture-examples-for-china-region-terraform/blob/718a45d536672e7f5f4e1fa6011e3acb27ab4f5a/LICENSE
# The whole file, unmodified.
#
# TF030: silent. Every group opens 22, but only to private ranges.


resource "aws_security_group" "worker_group_mgmt_one" {
  name_prefix = "worker_group_mgmt_one"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port = 22
    to_port   = 22
    protocol  = "tcp"

    cidr_blocks = [
      "10.0.0.0/8",
    ]
  }
}

resource "aws_security_group" "worker_group_mgmt_two" {
  name_prefix = "worker_group_mgmt_two"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port = 22
    to_port   = 22
    protocol  = "tcp"

    cidr_blocks = [
      "192.168.0.0/16",
    ]
  }
}

resource "aws_security_group" "all_worker_mgmt" {
  name_prefix = "all_worker_management"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port = 22
    to_port   = 22
    protocol  = "tcp"

    cidr_blocks = [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]
  }
}
