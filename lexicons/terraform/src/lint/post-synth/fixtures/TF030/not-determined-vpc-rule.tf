# Vendored for TF030 from https://github.com/aws-samples/sample-parallel-computing-service
# Path: modules/vpc/main.tf
# Commit: e74e5806f8fa203b268532f9f6c64e649b35708e
# Licence: MIT-0, https://github.com/aws-samples/sample-parallel-computing-service/blob/e74e5806f8fa203b268532f9f6c64e649b35708e/LICENSE
# Excerpt: lines 81-93, unmodified. The for_each map it reads, local.pcs_public_security_group_rules.ingress (lines 37-51 of the same file), does open 22 to 0.0.0.0/0.
#
# TF030: one info, Not determined: every attribute is each.value.*, so the rule cannot see the open SSH port that the locals declare. This is what the info finding is for.

resource "aws_security_group" "pcs_public" {
  name   = "${var.project}-public-sg"
  vpc_id = aws_vpc.pcs.id
}

resource "aws_vpc_security_group_ingress_rule" "pcs_public_allow_ingress" {
  for_each          = local.pcs_public_security_group_rules.ingress
  security_group_id = aws_security_group.pcs_public.id
  cidr_ipv4         = each.value.cidr_ipv4
  from_port         = each.value.from_port
  ip_protocol       = each.value.ip_protocol
  to_port           = each.value.to_port
}
