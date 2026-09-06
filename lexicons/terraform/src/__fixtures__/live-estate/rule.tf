# aws_security_group_rule carries no tags argument at all, so no ownership
# marker was ever written for it: live-ls reports it as a gap on the
# declaration-carried rung rather than as an absence.
resource "aws_security_group_rule" "https" {
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["10.99.0.0/16"]
  security_group_id = aws_security_group.main.id
}
