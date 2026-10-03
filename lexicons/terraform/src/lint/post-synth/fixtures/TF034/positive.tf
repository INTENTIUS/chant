# Vendored for TF034 (chant #2288) from https://github.com/Checkmarx/kics
# Path: assets/queries/terraform/aws/sns_topic_not_encrypted/test/positive1.tf
# Commit: 8a0f0bbaf380c6f9110bfe9808311f49aac45cde
# Licence: Apache-2.0, https://github.com/Checkmarx/kics/blob/8a0f0bbaf380c6f9110bfe9808311f49aac45cde/LICENSE
# The whole file, unmodified.
#
# KICS's own test corpus for "SNS Topic Not Encrypted".
#
# TF034: one warning. kms_master_key_id = "" names no key.

resource "aws_sns_topic" "user_updates" {
  name              = "user-updates-topic"
  kms_master_key_id = ""
}
