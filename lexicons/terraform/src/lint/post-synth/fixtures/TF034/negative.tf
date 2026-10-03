# Vendored for TF034 (chant #2288) from https://github.com/covidgreen/covid-green-infra
# Path: sns.tf
# Commit: 864d159afca9367db21cca05b1e8eb58038bdbd6
# Licence: Apache-2.0, https://github.com/covidgreen/covid-green-infra/blob/864d159afca9367db21cca05b1e8eb58038bdbd6/LICENSE
# The whole file, unmodified.
#
# TF034: silent. Both topics set kms_master_key_id = aws_kms_alias.sns.arn, an attribute of a managed alias,
# which is never empty.

resource "aws_sns_topic" "callback_email_notifications" {
  count = local.enable_callback_email_notifications_count

  name              = "${module.labels.id}-callback-email-notifications"
  kms_master_key_id = aws_kms_alias.sns.arn
  tags              = module.labels.tags
}

resource "aws_sns_topic" "daily_registrations_reporter" {
  count = local.lambda_daily_registrations_reporter_count

  name              = "${module.labels.id}-daily-registrations-reporter"
  kms_master_key_id = aws_kms_alias.sns.arn
  tags              = module.labels.tags
}
