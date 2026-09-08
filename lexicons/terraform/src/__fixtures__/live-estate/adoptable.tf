# Coverage: the content-matched adoption row (choudoufu #962, chant #2241). A
# VPC's identity is assigned by EC2 at create time, so no argument in this
# block determines it and `live-plan` reports the instance under `omissions`
# with reason NEEDS_DISCOVERY. The unmarked live VPC standing at this exact
# cidr is found by choudoufu's content matcher during the estate-wide sweep
# instead, and lands in the document's `adoptable[]` section rather than in
# `unowned[]`, which only ever carries identities the configuration declares.
#
# The recording creates that VPC out of band and never applies this block, so
# the row in `../live-plan.json` is a real content match rather than a bind.
resource "aws_vpc" "adoptable" {
  cidr_block = "10.88.0.0/16"
}
