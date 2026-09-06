# A live log group that exists in the account carrying no marker at all:
# live-plan reports it unowned at a declared identity with the exact tag
# write that would adopt it.
resource "aws_cloudwatch_log_group" "adoptable" {
  name              = "/stateless-e2e-block/adoptable"
  retention_in_days = 1
}

# A live log group carrying another estate's marker: unowned, and not this
# run's to adopt.
resource "aws_cloudwatch_log_group" "held_elsewhere" {
  name              = "/stateless-e2e-block/held-elsewhere"
  retention_in_days = 1
}

# Declared and never applied: nothing exists at this identity, so the plan
# omits it with reason ABSENT and proposes creating it.
resource "aws_cloudwatch_log_group" "never_applied" {
  name              = "/stateless-e2e-block/never-applied"
  retention_in_days = 1
}
