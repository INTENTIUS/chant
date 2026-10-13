# Vendored for TF035 (chant #2288) from https://github.com/cds-snc/notification-terraform
# Path: aws/common/sqs.tf
# Commit: f202d882331fa2814170e4a65695291797af282d
# Licence: MIT, https://github.com/cds-snc/notification-terraform/blob/f202d882331fa2814170e4a65695291797af282d/LICENSE
# Excerpt: lines 60-73, unmodified.
#
# TF035: silent. The queue sets neither sqs_managed_sse_enabled nor kms_master_key_id, so AWS's SSE-SQS default
# encrypts it. This is the case the bridged WAW026 got wrong on every queue.
#
# Copyright (c) 2020 Canadian Digital Service – Service numérique canadien
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

resource "aws_sqs_queue" "eks_notification_canada_cadelivery_receipts" {
  provider         = aws.core_services
  name             = "eks-notification-canada-cadelivery-receipts"
  delay_seconds    = 0
  max_message_size = var.sqs_max_message_size
  #4 Days
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 0
  visibility_timeout_seconds = var.sqs_visibility_timeout_default

  tags = {
    Environment = var.env
  }
}
